/**
 * Win Media Studios — booking form → Google Sheet + Google Calendar
 * ----------------------------------------------------------------
 * Each submission:
 *   1. appends a row to the "Bookings" tab of your Sheet, and
 *   2. creates a 30-minute event on your Google Calendar
 *      (and emails the booker a calendar invite).
 *
 * SETUP
 * 1. Paste this whole file into the Apps Script editor, Save.
 * 2. Function dropdown → choose "testAll" → Run → Authorise.
 *    (This grants BOTH the Sheets and Calendar permissions and
 *     drops one test row + one test calendar event so you can see
 *     it works. Delete them afterwards.)
 * 3. Deploy → Manage deployments → ✏️ edit → Version: "New version"
 *    → Deploy.  (Keeps the same /exec URL the website already uses.)
 *
 * Verify in a browser by opening the /exec URL: you should see JSON
 * with "version":"v3-calendar","sheetOk":true,"calendarOk":true.
 */

const SPREADSHEET_ID = '1shPEsOPtBZy5FVJLwhZoiKmw0neJ35D4ooxQalSxBlU';
const SHEET_NAME = 'Bookings';

// Leave '' to use your primary calendar. To use a specific calendar,
// put its Calendar ID here (Calendar settings → "Integrate calendar").
const CALENDAR_ID = '';

const EVENT_DURATION_MIN = 30;
const EVENT_TITLE_PREFIX = 'Discovery Call';
const INVITE_BOOKER = true; // email the booker a calendar invite

const HEADERS = [
  'Submitted at', 'Booking date', 'Booking time', 'Name', 'Phone',
  'WhatsApp', 'Email', 'Commitment', 'Monthly revenue', 'Running paid ads',
  'Calendar event'
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

function writeRow_(data, eventNote) {
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
    eventNote     || ''
  ]);
}

/* ---------- Calendar ---------- */
function createEvent_(data) {
  if (!data.startISO) return 'No start time provided';

  const cal = CALENDAR_ID
    ? CalendarApp.getCalendarById(CALENDAR_ID)
    : CalendarApp.getDefaultCalendar();
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
  if (INVITE_BOOKER && data.email) {
    options.guests = data.email;
    options.sendInvites = true;
  }

  const event = cal.createEvent(
    EVENT_TITLE_PREFIX + ' — ' + (data.name || 'New lead'),
    start, end, options
  );
  return event.getId();
}

/* ---------- Web endpoints ---------- */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const data = JSON.parse(e.postData.contents);

    let eventNote;
    try {
      eventNote = 'Added: ' + createEvent_(data);
    } catch (calErr) {
      eventNote = 'Calendar error: ' + calErr;
    }

    writeRow_(data, eventNote);
    return json({ result: 'success', calendar: eventNote });
  } catch (err) {
    return json({ result: 'error', error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  const status = { version: 'v3-calendar' };
  try {
    const sheet = getSheet_();
    status.sheetOk = true;
    status.spreadsheet = sheet.getParent().getName();
    status.rows = sheet.getLastRow();
  } catch (err) {
    status.sheetOk = false;
    status.sheetError = String(err);
  }
  try {
    const cal = CALENDAR_ID ? CalendarApp.getCalendarById(CALENDAR_ID) : CalendarApp.getDefaultCalendar();
    status.calendarOk = !!cal;
    status.calendar = cal ? cal.getName() : null;
  } catch (err) {
    status.calendarOk = false;
    status.calendarError = String(err);
  }
  return json(status);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ---------- One-time test (run from the editor) ---------- */
function testAll() {
  const now = new Date();
  const start = new Date(now.getTime() + 24 * 60 * 60 * 1000); // tomorrow
  const data = {
    date: 'MANUAL TEST — delete me',
    time: 'n/a',
    name: 'Editor Test',
    phone: '-', whatsapp: '-', email: '',
    commitment: 'Yes', revenue: 'n/a', ads: 'n/a',
    startISO: start.toISOString(),
    durationMins: 30
  };
  let note;
  try { note = 'Added: ' + createEvent_(data); }
  catch (err) { note = 'Calendar error: ' + err; }
  writeRow_(data, note);
  Logger.log(note);
}
