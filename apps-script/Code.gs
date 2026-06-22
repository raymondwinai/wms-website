/**
 * Win Media Studios — booking form → Google Sheet + Google Calendar + WhatsApp alert
 * ---------------------------------------------------------------------------------
 * Each submission:
 *   1. appends a row to the "Bookings" tab of your Sheet,
 *   2. creates a 30-minute event on your Google Calendar (and invites the booker),
 *   3. sends you a WhatsApp message (via the WhatsApp Cloud API).
 *
 * SECRETS — set these two in:
 *   Project Settings (⚙️) → Script properties → Add script property
 *     WHATSAPP_TOKEN  = your permanent access token (EAAT...)   <- secret
 *     WHATSAPP_TO     = recipient number, e.g. 65XXXXXXXX       <- your personal number
 *   (Phone number ID + template are plain config constants below.)
 *
 * SETUP / REDEPLOY
 * 1. Paste this file in, Save.
 * 2. Add the 3 script properties above.
 * 3. Run "testWhatsAppHello" once → authorise (it now also asks for
 *    "Connect to an external service") → you should get a "Hello World"
 *    WhatsApp message. That proves the token/number work.
 * 4. Create your real template (see chat), then run "testWhatsApp".
 * 5. Deploy → Manage deployments → ✏️ → Version: New version → Deploy.
 */

const SPREADSHEET_ID = '1shPEsOPtBZy5FVJLwhZoiKmw0neJ35D4ooxQalSxBlU';
const SHEET_NAME = 'Bookings';

const CALENDAR_ID = '';                 // '' = primary calendar
const EVENT_DURATION_MIN = 30;
const EVENT_TITLE_PREFIX = 'Discovery Call';
const INVITE_BOOKER = true;

const WHATSAPP_API_VERSION = 'v21.0';
const WHATSAPP_PHONE_ID = '1094004420472616';  // winmediastudios sender (+65 8907 9525)

// Using the built-in 'hello_world' template for now (already approved → works immediately).
// Once your custom 'new_lead' template is APPROVED, switch these two lines to:
//   const WHATSAPP_TEMPLATE = 'new_lead';
//   const WHATSAPP_LANG = 'en_US';   // (or 'en' — match the template's language)
const WHATSAPP_TEMPLATE = 'hello_world';
const WHATSAPP_LANG = 'en_US';

const HEADERS = [
  'Submitted at', 'Booking date', 'Booking time', 'Name', 'Phone',
  'WhatsApp', 'Email', 'Commitment', 'Monthly revenue', 'Running paid ads',
  'Notifications'
];

/* ---------- Sheet ---------- */
function getSheet_() {
  const ss = (SPREADSHEET_ID && SPREADSHEET_ID.indexOf('PASTE_') === -1)
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('No spreadsheet found. Check SPREADSHEET_ID.');

  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function writeRow_(data, note) {
  getSheet_().appendRow([
    new Date(),
    data.date     || '',
    data.time     || '',
    data.name     || '',
    data.phone    || '',
    data.whatsapp || '',
    data.email    || '',
    data.commitment || '',
    data.revenue  || '',
    data.ads      || '',
    note          || ''
  ]);
}

/* ---------- Calendar ---------- */
function createEvent_(data) {
  if (!data.startISO) return 'no start time';
  const cal = CALENDAR_ID ? CalendarApp.getCalendarById(CALENDAR_ID) : CalendarApp.getDefaultCalendar();
  if (!cal) throw new Error('Calendar not found. Check CALENDAR_ID.');

  const start = new Date(data.startISO);
  const mins = Number(data.durationMins) || EVENT_DURATION_MIN;
  const end = new Date(start.getTime() + mins * 60 * 1000);

  const description =
    'Booked via winmediastudios.com\n\n' +
    'Name: ' + (data.name || '') + '\n' +
    'Phone: ' + (data.phone || '') + '\n' +
    'WhatsApp: ' + (data.whatsapp || '') + '\n' +
    'Email: ' + (data.email || '') + '\n' +
    'Monthly revenue: ' + (data.revenue || '') + '\n' +
    'Running paid ads: ' + (data.ads || '') + '\n' +
    'Commitment: ' + (data.commitment || '');

  const options = { description: description };
  if (INVITE_BOOKER && data.email) { options.guests = data.email; options.sendInvites = true; }

  return cal.createEvent(EVENT_TITLE_PREFIX + ' — ' + (data.name || 'New lead'), start, end, options).getId();
}

/* ---------- WhatsApp ---------- */
function sendWhatsApp_(data) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('WHATSAPP_TOKEN');
  const to = props.getProperty('WHATSAPP_TO');
  if (!token || !to) return 'WhatsApp not configured (set WHATSAPP_TOKEN and WHATSAPP_TO)';

  const template = { name: WHATSAPP_TEMPLATE, language: { code: WHATSAPP_LANG } };
  // hello_world has no variables; custom templates like 'new_lead' take 3.
  if (WHATSAPP_TEMPLATE !== 'hello_world') {
    const whenStr = (data.date || '') + (data.time ? ' at ' + data.time : '');
    template.components = [{
      type: 'body',
      parameters: [
        { type: 'text', text: (data.name || 'New lead') },   // {{1}}
        { type: 'text', text: (data.phone || '-') },          // {{2}}
        { type: 'text', text: (data.email || '-') },          // {{3}}
        { type: 'text', text: (whenStr || '-') },             // {{4}}
        { type: 'text', text: (data.revenue || '-') }         // {{5}}
      ]
    }];
  }

  const url = 'https://graph.facebook.com/' + WHATSAPP_API_VERSION + '/' + WHATSAPP_PHONE_ID + '/messages';
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Authorization': 'Bearer ' + token },
    payload: JSON.stringify({ messaging_product: 'whatsapp', to: to, type: 'template', template: template }),
    muteHttpExceptions: true
  });
  return 'WA ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200);
}

/* ---------- Web endpoints ---------- */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const data = JSON.parse(e.postData.contents);

    let calNote;
    try { calNote = 'Cal: ' + createEvent_(data); } catch (err) { calNote = 'Cal error: ' + err; }

    let waNote;
    try { waNote = sendWhatsApp_(data); } catch (err) { waNote = 'WA error: ' + err; }

    writeRow_(data, calNote + ' | ' + waNote);
    return json({ result: 'success', calendar: calNote, whatsapp: waNote });
  } catch (err) {
    return json({ result: 'error', error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  const status = { version: 'v4-whatsapp' };
  try { const s = getSheet_(); status.sheetOk = true; status.spreadsheet = s.getParent().getName(); status.rows = s.getLastRow(); }
  catch (err) { status.sheetOk = false; status.sheetError = String(err); }
  try { const c = CALENDAR_ID ? CalendarApp.getCalendarById(CALENDAR_ID) : CalendarApp.getDefaultCalendar(); status.calendarOk = !!c; status.calendar = c ? c.getName() : null; }
  catch (err) { status.calendarOk = false; status.calendarError = String(err); }
  const p = PropertiesService.getScriptProperties();
  status.whatsappConfigured = !!(p.getProperty('WHATSAPP_TOKEN') && p.getProperty('WHATSAPP_TO'));
  status.whatsappTemplate = WHATSAPP_TEMPLATE;
  return json(status);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------- Tests (run from the editor) ---------- */

// Quick connectivity check using Meta's built-in "hello_world" template (no approval needed).
function testWhatsAppHello() {
  const p = PropertiesService.getScriptProperties();
  const url = 'https://graph.facebook.com/' + WHATSAPP_API_VERSION + '/' + WHATSAPP_PHONE_ID + '/messages';
  const payload = { messaging_product: 'whatsapp', to: p.getProperty('WHATSAPP_TO'), type: 'template', template: { name: 'hello_world', language: { code: 'en_US' } } };
  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + p.getProperty('WHATSAPP_TOKEN') }, payload: JSON.stringify(payload), muteHttpExceptions: true });
  Logger.log(res.getResponseCode() + ': ' + res.getContentText());
}

// Test your real 'new_lead' template with sample data.
function testWhatsApp() {
  Logger.log(sendWhatsApp_({
    name: 'Test Lead', phone: '+65 9123 4567', email: 'jane@company.com',
    date: 'Wednesday, 24 June 2026', time: '3:00 PM (SGT)', revenue: '$50k to $100k / month'
  }));
}

// Writes a test row + calendar event (Sheets/Calendar auth check).
function testAll() {
  const start = new Date(new Date().getTime() + 24 * 60 * 60 * 1000);
  const data = { date: 'MANUAL TEST — delete me', time: 'n/a', name: 'Editor Test', phone: '-', whatsapp: '-', email: '', commitment: 'Yes', revenue: 'n/a', ads: 'n/a', startISO: start.toISOString(), durationMins: 30 };
  let note; try { note = 'Cal: ' + createEvent_(data); } catch (e) { note = 'Cal error: ' + e; }
  writeRow_(data, note);
  Logger.log(note);
}
