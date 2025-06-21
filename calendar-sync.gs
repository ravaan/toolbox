/**
 * Combined Busy Calendar Synchronizer v2.4 (2025‑06‑22)
 * ------------------------------------------------------
 * Mirrors **busy** blocks from one or more **source calendars** into one or
 * more **destination calendars** for a configurable look‑ahead window.
 *
 *  • Two‑phase sync per destination — delete stale events, then add new ones.  
 *  • Events are tagged (`description`) with their source calendar‑id so the
 *    script can de‑duplicate cleanly next run.  
 *  • **Every destination MUST provide its own `sources` list.**  
 *  • Each destination **may** override the global `lookAheadDays`.  
 *  • Destinations are processed **in the order listed** — the first calendar
 *    always finishes first.  
 *  • Resilient: if any individual source or destination calendar errors out,
 *    the script logs the issue and continues with the rest.  
 *
 * Bind `syncBusyCalendars()` to a time‑driven trigger or run manually.
 *
 * ENV Google Apps Script (V8)
 * AUTHOR Arpit Agarwal
 */

/* ───────────────────────────── CONFIGURATION ───────────────────────────── */

const CONFIG = {
  /** Default look‑ahead window when a destination does not override (days) */
  lookAheadDays: 30,

  /**
   * Destination calendars (processed top‑to‑bottom)
   *  ─ id              : Destination calendar‑ID
   *  ─ sources[]       : REQUIRED. Array of source calendar‑IDs (string) **or**
   *                      objects of form { id: "…" }
   *  ─ lookAheadDays   : OPTIONAL. Overrides global window for this destination
   */
  destinationCalendars: [
    {
      id: 'group-calendar-id@group.calendar.google.com',
      sources: [
        '1@1.com',
        '2@2.com',
        '3@3.com'
      ],
      lookAheadDays: 14 // two‑week view for this calendar
    }
    // Add more destinations as needed…
  ]
};

/* ─────────────────────────────── PUBLIC ENTRY ──────────────────────────── */
/**
 * Main entry.
 *
 * @param {Object}  [opts]
 * @param {boolean} [opts.enableLogging=false] Verbose log output.
 * @param {number}  [opts.lookAheadDays]       Override global default window.
 */
function syncBusyCalendars (opts = {}) {
  const enableLogging        = opts.enableLogging ?? true;
  const defaultLookAheadDays = opts.lookAheadDays ?? CONFIG.lookAheadDays;

  CONFIG.destinationCalendars.forEach((dest, idx) => {
    if (!dest.sources || !dest.sources.length) {
      _log(true, `⚠️  DEST SKIPPED (#${idx + 1} — ${dest.id}): no sources configured`);
      return;
    }

    /* Determine look‑ahead window for this destination */
    const lookAheadDays = dest.lookAheadDays ?? defaultLookAheadDays;
    const [winStart, winEnd] = _getWindowBounds(lookAheadDays);
    _log(enableLogging, `\n🚀  START (#${idx + 1}) ${dest.id} — ${winStart.toDateString()} → ${winEnd.toDateString()}`);

    /* Collect source events (best‑effort) */
    const destSources = dest.sources.map(src => (typeof src === 'string' ? { id: src } : src));
    const { sourceEvents, sourceKeys } =
      _collectSourceEvents(destSources, winStart, winEnd, enableLogging);

    /* Sync the destination */
    let summary = { created: 0, deleted: 0 };
    try {
      summary = _syncDestination(dest, sourceEvents, sourceKeys,
                                 winStart, winEnd, enableLogging);
      _log(enableLogging, `   ↳ Summary: +${summary.created} / -${summary.deleted}`);
    } catch (e) {
      _log(true, `❌  DEST ERROR (${dest.id}): ${e.message}`);
    }
  });

  _log(enableLogging, `\n✅  DONE`);
}

/* ────────────────────────────── CORE LOGIC ─────────────────────────────── */
/**
 * Sync one destination calendar.
 *
 * @param {{id:string}}                      dest
 * @param {Array.<SourceEvent>}              sourceEvents
 * @param {Set<string>}                      sourceKeys
 * @param {Date}                             winStart
 * @param {Date}                             winEnd
 * @param {boolean}                          enableLogging
 * @return {{created:number,deleted:number}}
 */
function _syncDestination (dest, sourceEvents, sourceKeys,
                           winStart, winEnd, enableLogging) {
  const destCal = CalendarApp.getCalendarById(dest.id);
  if (!destCal) throw new Error('destination calendar not found');

  /* Build key‑set for existing destination events */
  const destEvents = destCal.getEvents(winStart, winEnd);
  const destKeys   = new Set(destEvents.map(e =>
    _buildKey(e.getStartTime(), e.getEndTime(), e.getDescription())
  ));
  _log(enableLogging, `   ↳ Loaded ${destEvents.length} dest events`);

  /* Phase 1 — CLEANUP */
  let deleted = 0;
  destEvents.forEach(ev => {
    const key = _buildKey(ev.getStartTime(), ev.getEndTime(), ev.getDescription());
    if (!sourceKeys.has(key)) {
      ev.deleteEvent();
      deleted++;
      _log(enableLogging, `   🗑️ Deleted: ${ev.getStartTime()}‑${ev.getEndTime()} (${ev.getDescription()})`);
    }
  });

  /* Phase 2 — ADDITION */
  const toCreate = sourceEvents.filter(se => !destKeys.has(se.key));
  toCreate.forEach(({ start, end, marker }) => {
    destCal.createEvent('Busy', start, end, { description: marker });
    _log(enableLogging, `   ✅ Created: ${start}‑${end} (${marker})`);
  });

  return { created: toCreate.length, deleted };
}

/* ─────────────────────────────── HELPERS ──────────────────────────────── */
/** Convert look‑ahead days → [start, end] Date objects. */
function _getWindowBounds (days) {
  const start = new Date();
  const end   = new Date(start.getTime() + days * 86_400_000); // 24 h × 60 m × 60 s × 1000 ms
  return [start, end];
}

/**
 * Pull events from all source calendars (best‑effort).
 *
 * @param {Array.<{id:string}>} srcCals
 * @param {Date}    winStart
 * @param {Date}    winEnd
 * @param {boolean} enableLogging
 * @return {{sourceEvents:Array.<SourceEvent>,sourceKeys:Set<string>}}
 */
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
        const key    = _buildKey(ev.getStartTime(), ev.getEndTime(), marker);
        sourceEvents.push({ start: ev.getStartTime(), end: ev.getEndTime(), marker, key });
        sourceKeys.add(key);
      });
    } catch (e) {
      _log(true, `❌ SRC ERROR (${id}): ${e.message}`);
    }
  });

  _log(enableLogging, `   ↳ Total unique source events: ${sourceEvents.length}`);
  return { sourceEvents, sourceKeys };
}

/** Build a unique key “start|end|marker”. */
function _buildKey (start, end, marker = '') {
  return `${start.getTime()}|${end.getTime()}|${marker}`;
}

/** Conditional logger. */
function _log (enabled, msg) { if (enabled) Logger.log(msg); }

/* ───────────────────────────── TYPE DEFS ──────────────────────────────── */
/**
 * @typedef  {Object}  SourceEvent
 * @property {Date}    start
 * @property {Date}    end
 * @property {string}  marker
 * @property {string}  key
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
