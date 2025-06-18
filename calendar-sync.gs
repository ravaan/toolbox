/**
 * syncBusyPattern1
 *
 * Two-phase sync (cleanup + add) for your “Combined Busy” calendar:
 * 1. Builds a Set of all source event keys (start|end|marker) from each src calendar.
 * 2. Fetches all destCal events in the same window:
 *    • Deletes any dest event whose key is NOT in the source Set.
 * 3. Adds any source event whose key was not in the original dest Set.
 *
 * Syncs for the next 30 days, tags by source ID, skips duplicates, and can log details.
 *
 * @param {boolean} enableLogging  
 *    If true, logs per-step & per-event details. Always logs start/end.
 */
function syncBusy(enableLogging = false) {
  const srcCalendars = [
    { id: 'cal1id@...',    requireAccepted: true  },
    { id: 'cal2id@...',           requireAccepted: false  }, // shared busy-only
    { id: 'cal3id@...',        requireAccepted: false },  // shared busy-only
  ];
  const destCalId = 'group-cal-id@group.calendar.google.com';
  const destCal   = CalendarApp.getCalendarById(destCalId);

  Logger.log(`syncBusyPattern1 START at ${new Date().toISOString()}`);

  // 1) Define time window
  const now   = new Date();
  const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // 2) Collect all source event keys
  const sourceEvents = [];
  const sourceKeys   = new Set();
  srcCalendars.forEach(({ id: srcId, requireAccepted }) => {
    if (enableLogging) Logger.log(`\n🔄 Fetching from ${srcId}`);
    let evts = CalendarApp.getCalendarById(srcId).getEvents(now, later);
    if (requireAccepted) {
      evts = evts.filter(e => e.getMyStatus() === CalendarApp.GuestStatus.YES);
      if (enableLogging) Logger.log(` → ${evts.length} accepted events`);
    } else if (enableLogging) {
      Logger.log(` → ${evts.length} total events`);
    }
    evts.forEach(e => {
      const startMs = e.getStartTime().getTime();
      const endMs   = e.getEndTime().getTime();
      const marker  = `from ${srcId}`;
      const key     = `${startMs}|${endMs}|${marker}`;
      sourceKeys.add(key);
      sourceEvents.push({ startMs, endMs, marker, key });
    });
  });

  // 3) Fetch destCal events & build destKeys
  const destEvents = destCal.getEvents(now, later);
  const destKeys   = new Set();
  destEvents.forEach(ev => {
    const s = ev.getStartTime().getTime();
    const e = ev.getEndTime().getTime();
    const m = ev.getDescription() || '';
    destKeys.add(`${s}|${e}|${m}`);
  });
  if (enableLogging) Logger.log(`\nLoaded ${destEvents.length} events from destCal`);

  // 4) Cleanup: delete dest events not in sourceKeys
  destEvents.forEach(ev => {
    const s = ev.getStartTime().getTime();
    const e = ev.getEndTime().getTime();
    const m = ev.getDescription() || '';
    const key = `${s}|${e}|${m}`;
    if (!sourceKeys.has(key)) {
      ev.deleteEvent();
      if (enableLogging) {
        Logger.log(`🗑️ Deleted stale: ${new Date(s).toISOString()} → ${new Date(e).toISOString()} (${m})`);
      }
    }
  });

  // 5) Addition: create missing source events
  const toCreate = sourceEvents.filter(({ key }) => !destKeys.has(key));
  if (enableLogging) {
    Logger.log(`\nCreating ${toCreate.length} new Busy event(s)`);
  }
  toCreate.forEach(({ startMs, endMs, marker }) => {
    destCal.createEvent(
      'Busy',
      new Date(startMs),
      new Date(endMs),
      { description: marker }
    );
    if (enableLogging) {
      Logger.log(`✅ Created: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()} (${marker})`);
    }
  });

  Logger.log(`syncBusyPattern1 DONE at ${new Date().toISOString()}`);
}

/**
 * Example usage:
 *   // Dry run: cleanup + add with minimal logging
 *   syncBusyPattern1(false);
 *
 *   // Verbose mode: see every step
 *   syncBusyPattern1(true);
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
