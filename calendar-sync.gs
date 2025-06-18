/**
 * syncBusyBulk
 *
 * Bulk-optimized aggregator:
 * - Syncs your busy slots from multiple source calendars (some require you to have
 *   accepted, others are “busy-only” shared so we include all).
 * - Tags each block with the source calendar ID.
 * - Skips duplicates based on identical start, end, and source marker.
 * - Syncs for the next 30 days.
 * - this will take time to sync for the first time but then will happend in less than 5 seconds
 *
 * @param {boolean} enableLogging  
 *    If true, logs per-calendar & per-event details. Always logs start/end.
 */
function syncBusyBulk(enableLogging = false) {
  // List each calendar + whether you only want events you’ve accepted
  const srcCalendars = [
    { id: 'cal1id@...',    requireAccepted: true  },
    { id: 'cal1id@...',           requireAccepted: false  }, // shared busy-only
    { id: 'cal1id@...',        requireAccepted: false },  // shared busy-only
  ];
  const destCalId = 'group-cal-id@...';
  const destCal   = CalendarApp.getCalendarById(destCalId);

  Logger.log(`syncBusyBulk START at ${new Date().toISOString()}`);

  // 1) Time window: now → 30 days from now
  const now   = new Date();
  const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  // 2) Fetch all existing “Busy” events once
  const existing = destCal.getEvents(now, later);
  if (enableLogging) {
    Logger.log(`Loaded ${existing.length} existing events from destCal`);
  }

  // 3) Build a Set of "start|end|marker"
  const existingKeys = new Set(
    existing.map(ev => {
      const s = ev.getStartTime().getTime();
      const e = ev.getEndTime().getTime();
      const m = ev.getDescription() || '';
      return `${s}|${e}|${m}`;
    })
  );

  // 4) Scan each source calendar, collect NEW slots
  const toCreate = [];
  srcCalendars.forEach(cfg => {
    const { id: srcId, requireAccepted } = cfg;
    if (enableLogging) Logger.log(`\n🔄 Checking source: ${srcId}`);

    // fetch all events in window
    let evts = CalendarApp.getCalendarById(srcId).getEvents(now, later);

    // if this calendar requires acceptance, filter accordingly
    if (requireAccepted) {
      evts = evts.filter(e => e.getMyStatus() === CalendarApp.GuestStatus.YES);
      if (enableLogging) {
        Logger.log(` → ${evts.length} ACCEPTED events in ${srcId}`);
      }
    } else if (enableLogging) {
      Logger.log(` → ${evts.length} total events (no acceptance filter) in ${srcId}`);
    }

    evts.forEach(e => {
      const start  = e.getStartTime().getTime();
      const end    = e.getEndTime().getTime();
      const marker = `from ${srcId}`;
      const key    = `${start}|${end}|${marker}`;

      if (!existingKeys.has(key)) {
        existingKeys.add(key);
        toCreate.push({ start, end, marker });
        if (enableLogging) {
          Logger.log(`  → Queued: ${new Date(start).toISOString()} → ${new Date(end).toISOString()} (${marker})`);
        }
      } else if (enableLogging) {
        Logger.log(`  ⏭️ Skipping duplicate: ${new Date(start).toISOString()} → ${new Date(end).toISOString()} (${marker})`);
      }
    });
  });

  // 5) Bulk-create all new events
  if (enableLogging) {
    Logger.log(`\nCreating ${toCreate.length} new Busy event(s) in destCal`);
  }
  toCreate.forEach(item => {
    destCal.createEvent(
      'Busy',
      new Date(item.start),
      new Date(item.end),
      { description: item.marker }
    );
  });

  Logger.log(`syncBusyBulk DONE at ${new Date().toISOString()}`);
}




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
