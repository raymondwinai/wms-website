/**
 * WMS Studio — booking backend (Google Apps Script web app)
 * ---------------------------------------------------------------------------------
 * Powers the booking calendar on studio.html:
 *   - reads free slots from a dedicated "WMS Studio" Google Calendar
 *   - holds a slot while the client pays (PayNow: 12 hrs, card: 35 min)
 *   - takes card payments through Stripe Checkout
 *   - logs every booking to the "Studio Bookings" tab of the WMS Lead Tracker sheet
 *   - emails the client and you at each step, and sends the client a calendar invite
 *
 * The Google Calendar is the source of truth for availability. Anything you add to the
 * "WMS Studio" calendar yourself (a client shoot, maintenance) blocks those hours, plus
 * the 1-hour reset either side.
 *
 * Confirming a PayNow payment: open the sheet and change that booking's Status from
 * PENDING to PAID. The client is then emailed their confirmation and calendar invite.
 * Changing Status to CANCELLED frees the slot.
 *
 * Setup steps are in apps-script/studio/README.md.
 */

/* =========================== CONFIG =========================== */

const CFG = {
  SITE_URL: 'https://winmediastudios.com/studio.html',
  STUDIO_NAME: 'WMS Studio',
  ADDRESS: '47 Kallang Pudding Rd, #09-13, Crescent @ Kallang, Singapore 349318',
  MAPS_LINK: 'https://www.google.com/maps/dir/?api=1&destination=Win%20Media%20Studios%2C%2047%20Kallang%20Pudding%20Rd%2C%20Singapore%20349318',
  WHATSAPP_DISPLAY: '+65 8939 7426',
  WHATSAPP_LINK: 'https://wa.me/6589397426',
  OWNER_EMAIL: '',                 // '' = the Google account that deploys this script

  SPREADSHEET_ID: '1shPEsOPtBZy5FVJLwhZoiKmw0neJ35D4ooxQalSxBlU',   // WMS Lead Tracker
  SHEET_NAME: 'Studio Bookings',
  CALENDAR_NAME: 'WMS Studio',

  OPEN_HOUR: 9,                    // first possible start, 24h clock (SGT)
  CLOSE_HOUR: 21,                  // everything must end by this hour
  MIN_NOTICE_HOURS: 24,            // earliest a session can be booked ahead
  MAX_DAYS_AHEAD: 60,
  TURNOVER_MIN: 60,                // studio reset between bookings
  MAX_HOURS: 4,
  FIRST_HOUR_SGD: 250,
  EXTRA_HOUR_SGD: 200,

  PAYNOW_HOLD_HOURS: 12,
  CARD_HOLD_MIN: 35,               // Stripe Checkout lasts 31 min; a little margin on top
  MAX_ACTIVE_HOLDS_PER_CLIENT: 2,  // stops one person tying up the calendar with unpaid holds

  TOUR_MIN: 15,
  TOUR_STEP_MIN: 30,
  TOUR_MIN_NOTICE_HOURS: 24,

  // PayNow details shown to clients. Fill ONE of UEN or MOBILE (mobile like '+6591234567').
  PAYNOW: { UEN: '', MOBILE: '', NAME: 'Win Media Studios' },

  SETS: ['The Library', 'The Lounge', 'The Den', 'Not sure yet']
};

const TZ = 'Asia/Singapore';
const TZ_OFFSET = '+08:00';        // Singapore has no daylight saving
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const TOUR_PREFIX = 'Tour · ';

const STATUS = { PENDING: 'PENDING', PAID: 'PAID', TOUR: 'TOUR', CANCELLED: 'CANCELLED', EXPIRED: 'EXPIRED' };
const COLS = ['Ref', 'Created', 'Status', 'Type', 'Payment', 'Start', 'End', 'Hours', 'Set', 'Amount (SGD)',
              'Name', 'Email', 'Phone', 'Notes', 'Hold until', 'Event ID', 'Stripe session', 'Token', 'Log'];
const C = COLS.reduce(function (m, h, i) { m[h] = i; return m; }, {});

/* =========================== PURE HELPERS ===========================
   No Google services in this block, so it can be unit-tested outside Apps Script. */

function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function priceFor_(hours) { return CFG.FIRST_HOUR_SGD + (hours - 1) * CFG.EXTRA_HOUR_SGD; }
function sgTime_(dayStr, hhmm) { return Date.parse(dayStr + 'T' + hhmm + ':00' + TZ_OFFSET); }
function sgDayStr_(ms) { return new Date(ms + 8 * HOUR).toISOString().slice(0, 10); }
function addDays_(dayStr, n) {
  const d = new Date(dayStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function minsToHhmm_(m) { return pad2_(Math.floor(m / 60)) + ':' + pad2_(m % 60); }
function isTour_(title) { return String(title || '').indexOf(TOUR_PREFIX) === 0; }

/* busy = [{ s, e, pad }] in ms. A new booking [s, e] clashes if it lands inside an
   existing one or within that booking's reset padding. Tours carry no padding. */
function conflicts_(s, e, busy) {
  for (let i = 0; i < busy.length; i++) {
    const b = busy[i];
    if (s < b.e + b.pad && e + b.pad > b.s) return true;
  }
  return false;
}

/* For one day: each on-the-hour start time and the longest session (1–MAX_HOURS) that fits. */
function sessionSlotsForDay_(dayStr, busy, nowMs) {
  const close = sgTime_(dayStr, pad2_(CFG.CLOSE_HOUR) + ':00');
  const earliest = nowMs + CFG.MIN_NOTICE_HOURS * HOUR;
  const out = [];
  for (let h = CFG.OPEN_HOUR; h < CFG.CLOSE_HOUR; h++) {
    const s = sgTime_(dayStr, pad2_(h) + ':00');
    if (s < earliest) continue;
    let max = 0;
    for (let d = 1; d <= CFG.MAX_HOURS; d++) {
      const e = s + d * HOUR;
      if (e > close || conflicts_(s, e, busy)) break;
      max = d;
    }
    if (max) out.push({ t: pad2_(h) + ':00', max: max });
  }
  return out;
}

/* Tours are 15 minutes, every 30 minutes, and only need the room to be free. */
function tourSlotsForDay_(dayStr, busy, nowMs) {
  const earliest = nowMs + CFG.TOUR_MIN_NOTICE_HOURS * HOUR;
  const noPad = busy.map(function (b) { return { s: b.s, e: b.e, pad: 0 }; });
  const out = [];
  for (let m = CFG.OPEN_HOUR * 60; m + CFG.TOUR_MIN <= CFG.CLOSE_HOUR * 60; m += CFG.TOUR_STEP_MIN) {
    const s = sgTime_(dayStr, minsToHhmm_(m));
    if (s < earliest) continue;
    if (!conflicts_(s, s + CFG.TOUR_MIN * MIN, noPad)) out.push({ t: minsToHhmm_(m) });
  }
  return out;
}

/* Validates a booking request. Returns a clean object, or throws { code, message }. */
function validateRequest_(p, type, nowMs) {
  const today = sgDayStr_(nowMs);
  const out = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.date || ''))) fail_('INVALID', 'Pick a date.');
  if (!/^\d{2}:\d{2}$/.test(String(p.time || ''))) fail_('INVALID', 'Pick a time.');
  if (p.date > addDays_(today, CFG.MAX_DAYS_AHEAD)) fail_('INVALID', 'That date is too far ahead to book online.');
  out.date = p.date; out.time = p.time;

  out.name = clean_(p.name, 80);
  out.email = clean_(p.email, 120).toLowerCase();
  out.phone = clean_(p.phone, 25);
  out.notes = clean_(p.notes, 500);
  if (out.name.length < 2) fail_('INVALID', 'Add your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) fail_('INVALID', 'Add a valid email address.');
  if (!/^\+?[\d\s()-]{6,20}$/.test(out.phone)) fail_('INVALID', 'Add a valid phone number.');

  const mins = Number(p.time.slice(0, 2)) * 60 + Number(p.time.slice(3, 5));
  out.start = sgTime_(p.date, p.time);

  if (type === 'tour') {
    if (mins < CFG.OPEN_HOUR * 60 || mins + CFG.TOUR_MIN > CFG.CLOSE_HOUR * 60 || mins % CFG.TOUR_STEP_MIN) fail_('INVALID', 'That tour time is outside studio hours.');
    if (out.start < nowMs + CFG.TOUR_MIN_NOTICE_HOURS * HOUR) fail_('TOO_SOON', 'Tours need to be booked at least ' + CFG.TOUR_MIN_NOTICE_HOURS + ' hours ahead.');
    out.end = out.start + CFG.TOUR_MIN * MIN;
    return out;
  }

  out.hours = Number(p.hours);
  if (!(out.hours >= 1 && out.hours <= CFG.MAX_HOURS && Math.floor(out.hours) === out.hours)) fail_('INVALID', 'Pick a session length.');
  out.set = CFG.SETS.indexOf(p.set) >= 0 ? p.set : 'Not sure yet';
  if (mins % 60 || mins < CFG.OPEN_HOUR * 60 || mins + out.hours * 60 > CFG.CLOSE_HOUR * 60) fail_('INVALID', 'That time is outside studio hours.');
  if (out.start < nowMs + CFG.MIN_NOTICE_HOURS * HOUR) fail_('TOO_SOON', 'Sessions need to be booked at least ' + CFG.MIN_NOTICE_HOURS + ' hours ahead.');
  if (p.payment !== 'paynow' && p.payment !== 'card') fail_('INVALID', 'Choose how you would like to pay.');
  if (p.agree !== true) fail_('INVALID', 'Please agree to the booking terms.');
  out.payment = p.payment;
  out.end = out.start + out.hours * HOUR;
  out.amount = priceFor_(out.hours);
  return out;
}

/* Trims and caps length. */
function clean_(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

/* Applied only when writing to the sheet: a leading ' stops "=...", "+..." etc. being run as formulas. */
function sheetText_(s) {
  s = String(s == null ? '' : s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function fail_(code, message) { const e = new Error(message); e.code = code; throw e; }
function setLabel_(set) { return set === 'Not sure yet' ? 'Set to be chosen' : set; }

/* =========================== WEB ENDPOINTS =========================== */

function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.action === 'availability') return json_(availability_(p.type === 'tour' ? 'tour' : 'session', p.from, p.days));
    return json_(status_());
  } catch (err) {
    return json_(errorBody_(err));
  }
}

function doPost(e) {
  let p;
  try { p = JSON.parse(e.postData.contents); } catch (_) { return json_({ ok: false, code: 'INVALID', message: 'Bad request.' }); }
  if (p.website) return json_({ ok: false, code: 'INVALID', message: 'Bad request.' });   // honeypot field
  try {
    if (p.action === 'hold') return json_(hold_(p));
    if (p.action === 'tour') return json_(tour_(p));
    if (p.action === 'verify') return json_(verify_(p));
    if (p.action === 'release') return json_(release_(p));
    return json_({ ok: false, code: 'INVALID', message: 'Unknown action.' });
  } catch (err) {
    return json_(errorBody_(err));
  }
}

function errorBody_(err) {
  if (err && err.code) return { ok: false, code: err.code, message: err.message };
  console.error(err && err.stack || err);
  return { ok: false, code: 'SERVER', message: 'Something went wrong on our side. Please try again, or WhatsApp us.' };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function status_() {
  const s = { ok: true, service: 'wms-studio-booking', version: 1 };
  try { studioCal_(); s.calendarOk = true; } catch (err) { s.calendarOk = false; }
  try { sheet_(); s.sheetOk = true; } catch (err) { s.sheetOk = false; }
  s.payments = payments_();
  return s;
}

function payments_() {
  return {
    paynow: !!(CFG.PAYNOW.UEN || CFG.PAYNOW.MOBILE),
    card: !!PropertiesService.getScriptProperties().getProperty('STRIPE_SECRET_KEY')
  };
}

function paynowPublic_() {
  if (CFG.PAYNOW.UEN) return { proxyType: 'UEN', proxy: CFG.PAYNOW.UEN, name: CFG.PAYNOW.NAME };
  if (CFG.PAYNOW.MOBILE) return { proxyType: 'MOBILE', proxy: CFG.PAYNOW.MOBILE, name: CFG.PAYNOW.NAME };
  return null;
}

/* ---------- availability ---------- */

function availability_(type, fromStr, days) {
  const now = Date.now();
  const today = sgDayStr_(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fromStr || '')) || fromStr < today) fromStr = today;
  days = Math.max(1, Math.min(CFG.MAX_DAYS_AHEAD + 1, Number(days) || CFG.MAX_DAYS_AHEAD + 1));

  const cache = CacheService.getScriptCache();
  const key = 'av:' + availVersion_() + ':' + type + ':' + fromStr + ':' + days;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);

  const startMs = sgTime_(fromStr, '00:00');
  const endMs = sgTime_(addDays_(fromStr, days), '00:00');
  const busy = busyBetween_(startMs, endMs);
  const last = addDays_(today, CFG.MAX_DAYS_AHEAD);
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays_(fromStr, i);
    if (d > last) break;
    out.push({ d: d, slots: type === 'tour' ? tourSlotsForDay_(d, busy, now) : sessionSlotsForDay_(d, busy, now) });
  }
  const res = {
    ok: true, type: type, days: out, payments: payments_(),
    rules: { minNoticeHours: type === 'tour' ? CFG.TOUR_MIN_NOTICE_HOURS : CFG.MIN_NOTICE_HOURS, maxHours: CFG.MAX_HOURS,
             firstHour: CFG.FIRST_HOUR_SGD, extraHour: CFG.EXTRA_HOUR_SGD, paynowHoldHours: CFG.PAYNOW_HOLD_HOURS }
  };
  cache.put(key, JSON.stringify(res), 120);
  return res;
}

function busyBetween_(startMs, endMs) {
  const pad = CFG.TURNOVER_MIN * MIN;
  return studioCal_().getEvents(new Date(startMs - pad), new Date(endMs + pad)).map(function (ev) {
    return { s: ev.getStartTime().getTime(), e: ev.getEndTime().getTime(), pad: isTour_(ev.getTitle()) ? 0 : pad };
  });
}

/* Cached availability is keyed by a version number that changes whenever a booking does. */
function availVersion_() {
  const c = CacheService.getScriptCache();
  let v = c.get('av-ver');
  if (!v) { v = String(Date.now()); c.put('av-ver', v, 21600); }
  return v;
}
function bumpAvail_() { CacheService.getScriptCache().put('av-ver', String(Date.now()), 21600); }

/* ---------- hold a session ---------- */

function hold_(p) {
  const now = Date.now();
  const r = validateRequest_(p, 'session', now);
  const pay = payments_();
  if (r.payment === 'paynow' && !pay.paynow) fail_('PAYMENT_OFF', 'PayNow is not available right now. Please choose card, or WhatsApp us.');
  if (r.payment === 'card' && !pay.card) fail_('PAYMENT_OFF', 'Card payment is not available right now. Please choose PayNow, or WhatsApp us.');

  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    if (conflicts_(r.start, r.end, busyBetween_(r.start, r.end))) fail_('SLOT_TAKEN', 'Someone has just booked that time. Please pick another.');
    if (activeHolds_(r.email, r.phone) >= CFG.MAX_ACTIVE_HOLDS_PER_CLIENT) {
      fail_('TOO_MANY_HOLDS', 'You already have unpaid holds waiting. Please complete or cancel those first, or WhatsApp us.');
    }

    const ref = newRef_();
    const token = Utilities.getUuid();
    const holdUntil = r.payment === 'paynow'
      ? Math.min(now + CFG.PAYNOW_HOLD_HOURS * HOUR, r.start - HOUR)
      : now + CFG.CARD_HOLD_MIN * MIN;
    const label = fmtRange_(r.start, r.end);

    const ev = studioCal_().createEvent(
      '⏳ Hold · ' + r.name + ' · ' + r.hours + 'h · ' + setLabel_(r.set),
      new Date(r.start), new Date(r.end),
      { description: eventDescription_(ref, r, 'Awaiting ' + (r.payment === 'paynow' ? 'PayNow — mark PAID in the sheet once received' : 'card payment')) });

    let session = null;
    if (r.payment === 'card') {
      try {
        session = stripe_('post', '/checkout/sessions', stripeSessionPayload_(ref, r, label, now));
      } catch (err) {
        ev.deleteEvent();
        throw err;
      }
    }

    sheet_().appendRow(rowFor_({
      ref: ref, created: new Date(now), status: STATUS.PENDING, type: 'Session',
      payment: r.payment === 'paynow' ? 'PayNow' : 'Card', start: new Date(r.start), end: new Date(r.end),
      hours: r.hours, set: r.set, amount: r.amount, name: r.name, email: r.email, phone: r.phone, notes: r.notes,
      holdUntil: new Date(holdUntil), eventId: ev.getId(), session: session ? session.id : '', token: token,
      log: 'Held ' + fmtStamp_(now)
    }));
    bumpAvail_();

    if (r.payment === 'paynow') {
      try { mailPaynowHeld_(ref, r, label, holdUntil); } catch (err) { console.error('client mail', err); }
      try { mailOwner_('New studio hold (PayNow) · ' + r.name + ' · ' + label,
        ['A PayNow booking is waiting for payment.', '', 'Ref: ' + ref, 'When: ' + label, 'Set: ' + setLabel_(r.set),
         'Amount: $' + r.amount, 'Name: ' + r.name, 'Email: ' + r.email, 'Phone: ' + r.phone, r.notes ? 'Notes: ' + r.notes : '',
         '', 'Held until ' + fmtStamp_(holdUntil) + '. Once the payment lands, change the Status to PAID in the sheet:',
         sheetUrl_()]); } catch (err) { console.error('owner mail', err); }
      return { ok: true, payment: 'paynow', ref: ref, amount: r.amount, label: label,
               holdUntil: new Date(holdUntil).toISOString(), holdUntilLabel: fmtStamp_(holdUntil), paynow: paynowPublic_() };
    }
    return { ok: true, payment: 'card', ref: ref, token: token, amount: r.amount, label: label, checkoutUrl: session.url };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- free tour ---------- */

function tour_(p) {
  const now = Date.now();
  const r = validateRequest_(p, 'tour', now);
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const busy = busyBetween_(r.start, r.end).map(function (b) { return { s: b.s, e: b.e, pad: 0 }; });
    if (conflicts_(r.start, r.end, busy)) fail_('SLOT_TAKEN', 'That tour time has just gone. Please pick another.');
    const ref = newRef_();
    const label = fmtRange_(r.start, r.end);
    const ev = studioCal_().createEvent(TOUR_PREFIX + r.name, new Date(r.start), new Date(r.end), {
      description: 'Free studio tour · Ref ' + ref + '\nEmail: ' + r.email + '\nPhone: ' + r.phone + (r.notes ? '\nNotes: ' + r.notes : ''),
      location: CFG.ADDRESS, guests: r.email, sendInvites: true
    });
    sheet_().appendRow(rowFor_({
      ref: ref, created: new Date(now), status: STATUS.TOUR, type: 'Tour', payment: 'Free', start: new Date(r.start), end: new Date(r.end),
      hours: '', set: '', amount: 0, name: r.name, email: r.email, phone: r.phone, notes: r.notes,
      holdUntil: '', eventId: ev.getId(), session: '', token: '', log: 'Booked ' + fmtStamp_(now)
    }));
    bumpAvail_();
    try { mailClient_(r.email, 'Your WMS Studio tour · ' + label, 'Your studio tour is booked.', [
      ['When', label], ['Where', CFG.ADDRESS], ['Reference', ref]],
      'You\'ll also get a calendar invite. Need to change the time? WhatsApp us on ' + CFG.WHATSAPP_DISPLAY + '.'); } catch (err) { console.error(err); }
    try { mailOwner_('New studio tour · ' + r.name + ' · ' + label,
      ['Ref: ' + ref, 'When: ' + label, 'Name: ' + r.name, 'Email: ' + r.email, 'Phone: ' + r.phone, r.notes ? 'Notes: ' + r.notes : '']); } catch (err) { console.error(err); }
    return { ok: true, ref: ref, label: label };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- card: verify after Stripe redirects back ---------- */

function verify_(p) {
  const ref = String(p.ref || ''), sessionId = String(p.sessionId || '');
  const row = findRow_(ref);
  if (!row || !sessionId || row.v[C['Stripe session']] !== sessionId) fail_('NOT_FOUND', 'We couldn\'t find that booking.');
  const label = fmtRange_(row.v[C['Start']].getTime(), row.v[C['End']].getTime());
  if (row.v[C['Status']] === STATUS.PAID) return { ok: true, status: STATUS.PAID, ref: ref, label: label };

  const session = stripe_('get', '/checkout/sessions/' + encodeURIComponent(sessionId));
  if (stripePaid_(session, row)) {
    const lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try {
      const fresh = findRow_(ref);
      if (fresh && fresh.v[C['Status']] === STATUS.PENDING) confirmPaid_(fresh, 'Card · Stripe ' + (session.payment_intent || session.id));
    } finally { lock.releaseLock(); }
    return { ok: true, status: STATUS.PAID, ref: ref, label: label };
  }
  return { ok: true, status: row.v[C['Status']], ref: ref, label: label };
}

/* ---------- card: client cancelled at checkout ---------- */

function release_(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const row = findRow_(String(p.ref || ''));
    if (!row || !p.token || row.v[C['Token']] !== p.token) fail_('NOT_FOUND', 'We couldn\'t find that booking.');
    if (row.v[C['Status']] !== STATUS.PENDING || row.v[C['Payment']] !== 'Card') return { ok: true, status: row.v[C['Status']] };
    const session = row.v[C['Stripe session']] ? stripe_('get', '/checkout/sessions/' + encodeURIComponent(row.v[C['Stripe session']])) : null;
    if (session && stripePaid_(session, row)) { confirmPaid_(row, 'Card · Stripe ' + (session.payment_intent || session.id)); return { ok: true, status: STATUS.PAID }; }
    if (session && session.status === 'open') { try { stripe_('post', '/checkout/sessions/' + session.id + '/expire', {}); } catch (err) { console.error(err); } }
    deleteEvent_(row.v[C['Event ID']]);
    updateRow_(row, { 'Status': STATUS.CANCELLED }, 'Released at checkout by client');
    bumpAvail_();
    return { ok: true, status: STATUS.CANCELLED };
  } finally {
    lock.releaseLock();
  }
}

/* =========================== CONFIRM / EXPIRE =========================== */

function confirmPaid_(row, via) {
  if (!row) return;
  const v = row.v;
  const r = { name: v[C['Name']], email: v[C['Email']], phone: v[C['Phone']], notes: v[C['Notes']], hours: v[C['Hours']],
              set: v[C['Set']], amount: v[C['Amount (SGD)']], payment: v[C['Payment']] === 'PayNow' ? 'paynow' : 'card' };
  const start = v[C['Start']].getTime(), end = v[C['End']].getTime();
  const ref = v[C['Ref']], label = fmtRange_(start, end);

  deleteEvent_(v[C['Event ID']]);
  const ev = studioCal_().createEvent(
    '🎙 Studio · ' + r.name + ' · ' + r.hours + 'h · ' + setLabel_(r.set), new Date(start), new Date(end),
    { description: eventDescription_(ref, r, 'PAID (' + via + ')'), location: CFG.ADDRESS, guests: r.email, sendInvites: true });
  updateRow_(row, { 'Status': STATUS.PAID, 'Event ID': ev.getId(), 'Hold until': '' }, 'Paid · ' + via);
  bumpAvail_();

  try { mailClient_(r.email, 'You\'re booked at WMS Studio · ' + label, 'You\'re booked. See you in the studio.', [
    ['When', label], ['Set', setLabel_(r.set)], ['Session', r.hours + (r.hours > 1 ? ' hours' : ' hour')],
    ['Paid', '$' + r.amount + ' (no GST)'], ['Where', CFG.ADDRESS], ['Reference', ref]],
    'Your calendar invite is on its way. Your engineer will have the set dressed and lit when you arrive. ' +
    'Need to reschedule? WhatsApp us on ' + CFG.WHATSAPP_DISPLAY + ' at least 48 hours before your start time and it\'s free. ' +
    'Inside 48 hours, or if you don\'t show, the payment is forfeited.', CFG.MAPS_LINK); } catch (err) { console.error(err); }
  if (r.payment === 'card') {
    try { mailOwner_('New studio booking (paid by card) · ' + r.name + ' · ' + label,
      ['Ref: ' + ref, 'When: ' + label, 'Set: ' + setLabel_(r.set), 'Paid: $' + r.amount, 'Name: ' + r.name, 'Email: ' + r.email,
       'Phone: ' + r.phone, r.notes ? 'Notes: ' + r.notes : '']); } catch (err) { console.error(err); }
  }
}

/* Runs every 15 minutes (installed by setup). Confirms card payments that landed without the
   client returning to the site, and releases holds that ran out. */
function expireHolds() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const now = Date.now();
    rows_().forEach(function (row) {
      const v = row.v;
      if (v[C['Status']] !== STATUS.PENDING) return;
      if (v[C['Payment']] === 'Card' && v[C['Stripe session']]) {
        try {
          const s = stripe_('get', '/checkout/sessions/' + encodeURIComponent(v[C['Stripe session']]));
          if (stripePaid_(s, row)) { confirmPaid_(row, 'Card · Stripe ' + (s.payment_intent || s.id)); return; }
        } catch (err) { console.error('stripe check', err); }
      }
      const until = v[C['Hold until']] instanceof Date ? v[C['Hold until']].getTime() : 0;
      if (until && now > until) {
        deleteEvent_(v[C['Event ID']]);
        updateRow_(row, { 'Status': STATUS.EXPIRED }, 'Hold expired, slot released');
        bumpAvail_();
        if (v[C['Payment']] === 'PayNow') {
          try { mailClient_(v[C['Email']], 'Your WMS Studio hold has been released (' + v[C['Ref']] + ')',
            'Your held slot has been released.',
            [['Was', fmtRange_(v[C['Start']].getTime(), v[C['End']].getTime())], ['Reference', v[C['Ref']]]],
            'We didn\'t receive payment in time, so we\'ve freed the slot. If you\'ve already paid, WhatsApp us on ' +
            CFG.WHATSAPP_DISPLAY + ' and we\'ll sort it out. You can book again anytime at ' + CFG.SITE_URL); } catch (err) { console.error(err); }
        }
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/* Installable on-edit trigger on the sheet (installed by setup). */
function onSheetEdit(e) {
  if (!e || !e.range || e.range.getSheet().getName() !== CFG.SHEET_NAME) return;
  if (e.range.getColumn() !== C['Status'] + 1 || e.range.getNumRows() !== 1 || e.range.getRow() < 2) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    const row = rowAt_(e.range.getRow());
    const next = String(e.value || '').toUpperCase(), prev = String(e.oldValue || '').toUpperCase();
    if (next === STATUS.PAID && prev === STATUS.PENDING) {
      confirmPaid_(row, row.v[C['Payment']] === 'PayNow' ? 'PayNow, confirmed in sheet' : 'confirmed in sheet');
    } else if (next === STATUS.CANCELLED && prev !== STATUS.CANCELLED) {
      deleteEvent_(row.v[C['Event ID']]);
      appendLog_(row, 'Cancelled in sheet, slot released');
      bumpAvail_();
    }
  } finally {
    lock.releaseLock();
  }
}

/* =========================== STRIPE =========================== */

function stripe_(method, path, payload) {
  const key = PropertiesService.getScriptProperties().getProperty('STRIPE_SECRET_KEY');
  if (!key) fail_('PAYMENT_OFF', 'Card payment is not available right now.');
  const opts = { method: method, headers: { Authorization: 'Bearer ' + key }, muteHttpExceptions: true };
  if (payload) opts.payload = payload;
  const res = UrlFetchApp.fetch('https://api.stripe.com/v1' + path, opts);
  const body = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 300) {
    console.error('Stripe ' + res.getResponseCode() + ': ' + res.getContentText());
    fail_('PAYMENT_ERROR', 'The card payment could not be started. Please try again, choose PayNow, or WhatsApp us.');
  }
  return body;
}

function stripeSessionPayload_(ref, r, label, nowMs) {
  return {
    'mode': 'payment',
    'payment_method_types[0]': 'card',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'sgd',
    'line_items[0][price_data][unit_amount]': String(r.amount * 100),
    'line_items[0][price_data][product_data][name]': CFG.STUDIO_NAME + ' · ' + r.hours + (r.hours > 1 ? ' hours' : ' hour') + ' · ' + setLabel_(r.set),
    'line_items[0][price_data][product_data][description]': label,
    'customer_email': r.email,
    'client_reference_id': ref,
    'metadata[ref]': ref,
    'success_url': CFG.SITE_URL + '?booking=' + ref + '&session_id={CHECKOUT_SESSION_ID}#book',
    'cancel_url': CFG.SITE_URL + '?booking=' + ref + '&cancelled=1#book',
    'expires_at': String(Math.floor(nowMs / 1000) + 31 * 60)
  };
}

/* Only trusts a session that is paid, belongs to this booking and is for the right amount. */
function stripePaid_(session, row) {
  return session && session.payment_status === 'paid' &&
         session.client_reference_id === row.v[C['Ref']] &&
         Number(session.amount_total) === Number(row.v[C['Amount (SGD)']]) * 100 &&
         String(session.currency).toLowerCase() === 'sgd';
}

/* =========================== SHEET / CALENDAR =========================== */

function sheet_() {
  const ss = SpreadsheetApp.openById(CFG.SPREADSHEET_ID);
  let sh = ss.getSheetByName(CFG.SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(CFG.SHEET_NAME);
    sh.appendRow(COLS);
    sh.getRange(1, 1, 1, COLS.length).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(2, C['Status'] + 1, 999, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(Object.keys(STATUS), true).build());
    sh.hideColumns(C['Token'] + 1);
  }
  return sh;
}

function sheetUrl_() { return SpreadsheetApp.openById(CFG.SPREADSHEET_ID).getUrl() + '#gid=' + sheet_().getSheetId(); }

function rowFor_(o) {
  const a = new Array(COLS.length).fill('');
  a[C['Ref']] = o.ref; a[C['Created']] = o.created; a[C['Status']] = o.status; a[C['Type']] = o.type;
  a[C['Payment']] = o.payment; a[C['Start']] = o.start; a[C['End']] = o.end; a[C['Hours']] = o.hours;
  a[C['Set']] = o.set; a[C['Amount (SGD)']] = o.amount; a[C['Name']] = sheetText_(o.name); a[C['Email']] = sheetText_(o.email);
  a[C['Phone']] = sheetText_(o.phone); a[C['Notes']] = sheetText_(o.notes); a[C['Hold until']] = o.holdUntil; a[C['Event ID']] = o.eventId;
  a[C['Stripe session']] = o.session; a[C['Token']] = o.token; a[C['Log']] = o.log;
  return a;
}

function rows_() {
  const values = sheet_().getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) out.push({ r: i + 1, v: values[i] });
  return out;
}
function rowAt_(r) { return { r: r, v: sheet_().getRange(r, 1, 1, COLS.length).getValues()[0] }; }
function findRow_(ref) {
  if (!/^WMS-[A-Z0-9]{6}$/.test(ref)) return null;
  const all = rows_();
  for (let i = 0; i < all.length; i++) if (all[i].v[C['Ref']] === ref) return all[i];
  return null;
}
function activeHolds_(email, phone) {
  const digits = String(phone).replace(/\D/g, '');
  return rows_().filter(function (row) {
    return row.v[C['Status']] === STATUS.PENDING &&
      (row.v[C['Email']] === email || String(row.v[C['Phone']]).replace(/\D/g, '') === digits);
  }).length;
}
function updateRow_(row, changes, logMsg) {
  const sh = sheet_();
  Object.keys(changes).forEach(function (k) { sh.getRange(row.r, C[k] + 1).setValue(changes[k]); row.v[C[k]] = changes[k]; });
  if (logMsg) appendLog_(row, logMsg);
}
function appendLog_(row, msg) {
  const cell = sheet_().getRange(row.r, C['Log'] + 1);
  const prev = String(cell.getValue() || '');
  cell.setValue((prev ? prev + ' | ' : '') + msg + ' ' + fmtStamp_(Date.now()));
}

function studioCal_() {
  const id = PropertiesService.getScriptProperties().getProperty('STUDIO_CALENDAR_ID');
  const cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) throw new Error('Studio calendar not found. Run setup() in the Apps Script editor.');
  return cal;
}
function deleteEvent_(id) {
  if (!id) return;
  try { const ev = studioCal_().getEventById(id); if (ev) ev.deleteEvent(); } catch (err) { console.error('delete event', err); }
}
function eventDescription_(ref, r, statusLine) {
  return ['Ref: ' + ref, 'Status: ' + statusLine, 'Name: ' + r.name, 'Email: ' + r.email, 'Phone: ' + r.phone,
          'Set: ' + setLabel_(r.set), 'Amount: $' + r.amount, r.notes ? 'Notes: ' + r.notes : ''].filter(String).join('\n');
}
function newRef_() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const hex = Utilities.getUuid().replace(/-/g, '');
  let s = '';
  for (let i = 0; i < 6; i++) s += A[parseInt(hex.substr(i * 2, 2), 16) % A.length];
  return 'WMS-' + s;
}

/* =========================== FORMAT + EMAIL =========================== */

function fmtTime_(ms) { return Utilities.formatDate(new Date(ms), TZ, 'h:mm a').replace('AM', 'am').replace('PM', 'pm'); }
function fmtRange_(s, e) { return Utilities.formatDate(new Date(s), TZ, 'EEE d MMM yyyy') + ', ' + fmtTime_(s) + ' – ' + fmtTime_(e); }
function fmtStamp_(ms) { return Utilities.formatDate(new Date(ms), TZ, 'EEE d MMM, h:mm a').replace('AM', 'am').replace('PM', 'pm'); }

function ownerEmail_() { return CFG.OWNER_EMAIL || Session.getEffectiveUser().getEmail(); }

function mailOwner_(subject, lines) {
  MailApp.sendEmail({ to: ownerEmail_(), subject: subject, body: lines.filter(function (l) { return l !== null; }).join('\n'), name: CFG.STUDIO_NAME });
}

function mailPaynowHeld_(ref, r, label, holdUntil) {
  const pn = paynowPublic_();
  mailClient_(r.email, 'Your WMS Studio slot is held · pay to confirm (' + ref + ')', 'Your slot is held. Pay to confirm it.', [
    ['When', label], ['Set', setLabel_(r.set)], ['Amount', '$' + r.amount + ' (no GST)'],
    ['Pay by PayNow to', pn ? (pn.proxyType === 'UEN' ? 'UEN ' : '') + pn.proxy + ' (' + pn.name + ')' : 'WhatsApp us for details'],
    ['Payment reference', ref], ['Held until', fmtStamp_(holdUntil)]],
    'Please include the reference with your payment. Once it lands we\'ll email your confirmation and calendar invite. ' +
    'If we haven\'t received payment by ' + fmtStamp_(holdUntil) + ', the slot is released. ' +
    'Free reschedule or cancellation up to 48 hours before your start time; inside 48 hours, the payment is forfeited.');
}

function mailClient_(to, subject, heading, rows, note, linkHref) {
  const esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  const text = [heading, ''].concat(rows.map(function (x) { return x[0] + ': ' + x[1]; }))
    .concat(['', note, linkHref ? 'Directions: ' + linkHref : '', '', CFG.STUDIO_NAME + ' · ' + CFG.ADDRESS]).join('\n');
  const SANS = '-apple-system,BlinkMacSystemFont,SF Pro Text,Helvetica Neue,Helvetica,Arial,sans-serif';   // no quotes: it sits inside style="…"
  const html =
    '<div style="background:#f6f4f0;padding:24px 12px;font-family:' + SANS + ';color:#1c1a17">' +
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:22px;padding:28px 24px">' +
    '<div style="font-size:13px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:#8F5A14;margin:0 0 10px">' + CFG.STUDIO_NAME + '</div>' +
    '<div style="font-size:26px;line-height:1.2;font-weight:700;letter-spacing:-.5px;margin:0 0 18px">' + esc(heading) + '</div>' +
    '<table style="width:100%;border-collapse:collapse;font-size:15px;line-height:1.45">' +
    rows.map(function (x) {
      return '<tr><td style="padding:11px 0;border-top:1px solid #e8e3da;color:#6b665e;width:42%;vertical-align:top">' + esc(x[0]) +
             '</td><td style="padding:11px 0;border-top:1px solid #e8e3da;font-weight:500;text-align:right">' + esc(x[1]) + '</td></tr>';
    }).join('') + '</table>' +
    '<p style="font-size:15px;line-height:1.5;color:#6b665e;margin:20px 0">' + esc(note) + '</p>' +
    (linkHref ? '<p style="margin:0 0 6px"><a href="' + linkHref + '" style="display:inline-block;font-size:15px;font-weight:600;color:#1a1206;background:#C8862F;padding:12px 20px;text-decoration:none;border-radius:980px">Get directions</a></p>' : '') +
    '</div>' +
    '<p style="max-width:560px;margin:14px auto 0;font-size:12px;line-height:1.5;color:#8c867b;text-align:center">' + esc(CFG.ADDRESS) +
    '<br>WhatsApp ' + esc(CFG.WHATSAPP_DISPLAY) + '</p></div>';
  MailApp.sendEmail({ to: to, subject: subject, body: text, htmlBody: html, name: CFG.STUDIO_NAME, replyTo: ownerEmail_() });
}

/* =========================== SETUP (run once from the editor) =========================== */

function setup() {
  const props = PropertiesService.getScriptProperties();
  let cal = props.getProperty('STUDIO_CALENDAR_ID') ? CalendarApp.getCalendarById(props.getProperty('STUDIO_CALENDAR_ID')) : null;
  if (!cal) {
    cal = CalendarApp.createCalendar(CFG.CALENDAR_NAME, { timeZone: TZ, color: CalendarApp.Color.YELLOW,
      summary: 'Studio bookings from winmediastudios.com. Add your own events here to block studio time.' });
    props.setProperty('STUDIO_CALENDAR_ID', cal.getId());
  }
  sheet_();

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['expireHolds', 'onSheetEdit'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('expireHolds').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(SpreadsheetApp.openById(CFG.SPREADSHEET_ID)).onEdit().create();

  Logger.log('Calendar: ' + cal.getName() + ' (' + cal.getId() + ')');
  Logger.log('Sheet tab: ' + CFG.SHEET_NAME + ' · ' + sheetUrl_());
  Logger.log('Payments: ' + JSON.stringify(payments_()));
}
