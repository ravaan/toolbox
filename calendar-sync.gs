/**
 * Busy-Sync for Google Calendar
 * =============================
 * Mirrors “Busy” blocks from multiple **source calendars** into one or more
 * **destination calendars** for a configurable look-ahead window.
 *
 * ––– FEATURES –––
 * • Two-phase sync per destination (delete stale, then add new)
 * • Events are tagged with their source calendar-id (`description`) so
 *   subsequent runs de-duplicate cleanly
 * • Destinations are processed **in order** — first one finishes first
 * • Resilient: if any source or destination calendar throws, the script
 *   logs the error and continues
 * • Optional e-mail summary per destination
 *
 * ––– USAGE –––
 *   1. Fill in the CONFIG section with your own calendar IDs / emails.
 *   2. Deploy as “Apps Script” and bind `syncBusyCalendars()` to a
 *      time-driven trigger (e.g. every 15 minutes).
 *   3. Commit this file to GitHub. No secrets are hard-coded.
 *
 * ENV  Google Apps Script (V8 runtime)
 * AUTHOR Your Name
 * LICENSE MIT
 * VERSION 2.1.0 (2025-06-22)
 */

/* ───────────────────────────── CONFIGURATION ──────────────────────────── *
 * Replace each placeholder with **your** values before first run.
 * No secrets? Add this file to Git and you’re good.                       */

const CONFIG = {
  /** How far ahead to mirror events (in days) */
  lookAheadDays: 30,

  /** Source calendars — replace with your IDs */
  sourceCalendars: [
    { id: 'YOUR_SOURCE_CAL_ID_1' },
    { id: 'YOUR_SOURCE_CAL_ID_2' },
    { id: 'YOUR_SOURCE_CAL_ID_3' }
  ],

  /** Destination calendars (processed top-to-bottom) */
  destinationCalendars: [
    {
      id: 'YOUR_DEST_CAL_ID_1',
      /* Optional summary e-mail list (comma-separated) */
      notifyEmails: ['your.email@example.com']
    }
    // { id: 'YOUR_DEST_CAL_ID_2', notifyEmails: [] }
  ]
};

/* ─────────────────────────────── PUBLIC ENTRY ─────────────────────────── */
/**
 * Main entry point.
 *
 * @param {Object}  [opts]
 * @param {boolean} [opts.enableLogging=false] Verbose stack-driver logs
 * @param {number}  [opts.lookAheadDays]       Override default window
 */
function syncBusyCalendars (opts = {}) {
  const enableLogging = opts.enableLogging ?? false;
  const lookAheadDays = opts.lookAheadDays ?? CONFIG.lookAheadDays;

  const [winStart, winEnd] = _windowBounds(lookAheadDays);
  _log(enableLogging,
       `🚀 Busy-Sync START — ${winStart.toDateString()} → ${winEnd.toDateString()}`);

  /* 1️⃣ COLLECT SOURCE EVENTS (best-effort) */
  const { sourceEvents, sourceKeys } =
    _collectSourceEvents(CONFIG.sourceCalendars, winStart, winEnd, enableLogging);

  /* 2️⃣ SYNC EACH DESTINATION (order matters) */
  CONFIG.destinationCalendars.forEach((dest, idx) => {
    let summary = { created: 0, deleted: 0 };

    try {
      summary = _syncDestination(dest, sourceEvents, sourceKeys,
                                 winStart, winEnd, enableLogging);
    } catch (e) {
      _log(true, `❌ DEST ERROR (${dest.id}): ${e.message}`);
      dest.errored = true;
    }

    if (dest.notifyEmails?.length) _sendSummaryEmail(dest, summary, lookAheadDays);
    _log(enableLogging, `— Finished destination #${idx + 1}: ${dest.id}`);
  });

  _log(enableLogging, '✅ Busy-Sync DONE');
}

/* ────────────────────────────── CORE LOGIC ────────────────────────────── */
function _syncDestination (dest, sourceEvents, sourceKeys,
                           winStart, winEnd, enableLogging) {
  const destCal = CalendarApp.getCalendarById(dest.id);
  if (!destCal) throw new Error('destination calendar not found');

  _log(enableLogging, `\n🔄 Syncing → ${dest.id}`);

  /* Build key-set of existing destination events */
  const destEvents = destCal.getEvents(winStart, winEnd);
  const destKeys   = new Set(destEvents.map(e =>
    _key(e.getStartTime(), e.getEndTime(), e.getDescription())
  ));

  /* Phase 1 — CLEANUP */
  let deleted = 0;
  destEvents.forEach(ev => {
    const key = _key(ev.getStartTime(), ev.getEndTime(), ev.getDescription());
    if (!sourceKeys.has(key)) { ev.deleteEvent(); deleted++; }
  });

  /* Phase 2 — ADDITION */
  const toCreate = sourceEvents.filter(se => !destKeys.has(se.key));
  toCreate.forEach(({ start, end, marker }) =>
    destCal.createEvent('Busy', start, end, { description: marker })
  );

  const created = toCreate.length;
  _log(enableLogging, `   ↳ ${created} created, ${deleted} deleted`);
  return { created, deleted };
}

/* ─────────────────────────────── HELPERS ──────────────────────────────── */
const ONE_DAY_MS = 86_400_000;

/** Convert look-ahead days → [start, end] Date objects. */
function _windowBounds (days) {
  const start = new Date();
  const end   = new Date(start.getTime() + days * ONE_DAY_MS);
  return [start, end];
}

function _collectSourceEvents (srcCals, winStart, winEnd, enableLogging) {
  const sourceEvents = [];
  const sourceKeys   = new Set();

  srcCals.forEach(({ id }) => {
    try {
      const cal    = CalendarApp.getCalendarById(id);
      if (!cal) throw new Error('calendar not found');
      const events = cal.getEvents(winStart, winEnd);

      _log(enableLogging, `• Pulled ${events.length} event(s) from ${id}`);
      events.forEach(ev => {
        const marker = `from ${id}`;
        const key    = _key(ev.getStartTime(), ev.getEndTime(), marker);
        sourceEvents.push({ start: ev.getStartTime(), end: ev.getEndTime(), marker, key });
        sourceKeys.add(key);
      });
    } catch (e) {
      _log(true, `❌ SRC ERROR (${id}): ${e.message}`);
    }
  });

  return { sourceEvents, sourceKeys };
}

/** Build a unique key “start|end|marker”. */
const _key = (start, end, marker = '') =>
  `${start.getTime()}|${end.getTime()}|${marker}`;

/**
 * Send an e-mail summary (optional). Errors are swallowed to avoid
 * interrupting subsequent destinations.
 */
function _sendSummaryEmail (dest, summary, lookAheadDays) {
  try {
    const subject = `Busy-Sync summary → ${dest.id}`;
    const body =
      `Busy-Sync completed\n\n` +
      `Destination   : ${dest.id}\n` +
      `Window (days) : ${lookAheadDays}\n` +
      `Added events  : ${summary.created}\n` +
      `Removed events: ${summary.deleted}\n` +
      `Status        : ${dest.errored ? 'ERROR' : 'OK'}\n` +
      `Timestamp     : ${new Date().toISOString()}\n`;

    MailApp.sendEmail(dest.notifyEmails.join(','), subject, body);
  } catch (e) {
    Logger.log(`❌ MAIL ERROR (${dest.id}): ${e.message}`);
  }
}

/** Conditional logger. */
const _log = (enabled, msg) => { if (enabled) Logger.log(msg); };

/* ───────────────────────────── TYPE DEFINITIONS ───────────────────────── */
/**
 * @typedef  {Object}  SourceEvent
 * @property {Date}    start   Event start date
 * @property {Date}    end     Event end date
 * @property {string}  marker  “from <calendar-id>”
 * @property {string}  key     Unique key for de-duplication
 */



/**
 * purgeFutureEvents(deleteFlag)
 *
 * Lists or deletes all future events in the specified Google Calendar.
 * When deleteFlag is false, it only logs each slot (grouped by start+end),
 * indicates duplicates, and shows each event’s title and description (your source marker).
 * When deleteFlag is true, it deletes every future event in that calendar.
 *
 * Only events from the given CALENDAR_ID are touched.
 *
 * HOW TO USE:
 * 1. Replace 'YOUR_CALENDAR_ID_HERE@group.calendar.google.com' with your actual calendar ID.
 * 2. In Apps Script, click ▶️ Run → purgeFutureEvents(false) to **list** only.
 * 3. After confirming the list, run ▶️ Run → purgeFutureEvents(true) to **delete**.
 */

function purgeFutureEvents(deleteFlag = false) {
  const CALENDAR_ID = 'group-calendar@group.calendar.google.com';
  const calendar    = CalendarApp.getCalendarById(CALENDAR_ID);
  const now         = new Date();
  // Far-future cutoff (will capture events up to year 2100)
  const futureLimit = new Date('2100-01-01T00:00:00Z');

  // Fetch all events from now → futureLimit
  const events = calendar.getEvents(now, futureLimit);
  Logger.log(`Found ${events.length} future event(s) in calendar: ${CALENDAR_ID}`);

  // Group events by exact start+end timestamp
  const groups = {};
  events.forEach(ev => {
    const key = ev.getStartTime().getTime() + '_' + ev.getEndTime().getTime();
    (groups[key] = groups[key] || []).push(ev);
  });

  // Iterate each group: if deleteFlag → delete all; else → log details
  Object.keys(groups).forEach(key => {
    const [startMs, endMs] = key.split('_').map(Number);
    const start = new Date(startMs);
    const end   = new Date(endMs);
    const group = groups[key];

    if (deleteFlag) {
      Logger.log(`→ Deleting ${group.length} event(s) from ${start} → ${end}`);
      group.forEach(ev => ev.deleteEvent());
    } else {
      const tag = group.length > 1 ? 'DUPLICATE SLOT' : 'SLOT';
      Logger.log(`\n[${tag}] ${start} → ${end} (${group.length} event(s))`);
      group.forEach((ev, i) => {
        Logger.log(
          `  #${i+1} Title: "${ev.getTitle()}", ` +
          `Description: "${ev.getDescription()}"`
        );
      });
    }
  });
}

/**
 * Example calls:
 *
 * // 1) Dry run: list all future events & duplicates (no deletion)
 * purgeFutureEvents(false);
 *
 * // 2) Actual run: delete all future events
 * //    (only run after you’ve confirmed the listing above!)
 * purgeFutureEvents(true);
 */
