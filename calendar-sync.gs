/**
 * syncBusy
 *
 * Aggregates busy slots from multiple source Google Calendars into a single
 * “Combined Busy” calendar. Tags each block with the source calendar ID and 
 * skips duplicates based on identical start, end, and source marker.
 *
 * Deployment steps:
 * 1. In Google Calendar, create a new calendar (e.g. “Combined Busy”) and
 *    copy its Calendar ID (Settings → Integrate calendar → Calendar ID).
 * 2. Go to https://script.google.com, click “New project” and name it (e.g. “Busy-Aggregator”).
 * 3. Replace the placeholder in destCal.getCalendarById(...) with your Combined Busy ID.
 * 4. Save and click ▶ Run → syncBusy to grant Calendar permissions.
 * 5. In the Apps Script editor, open “Triggers” (clock icon) → “Add Trigger”:
 *      • Function:          syncBusy
 *      • Event source:      Time-driven
 *      • Type:              Minutes timer
 *      • Interval:          Every minute
 * 6. Monitor executions (Executions tab) and adjust the 7-day window if needed.
 *
 * How it works:
 *  - srcIds:   Array of source calendar IDs.
 *  - destCal:  The Combined Busy calendar object.
 *  - now/later:  Defines the 7-day lookahead window.
 *  - For each source event:
 *      • Compute start/end timestamps and build a “marker” string.
 *      • Query destCal for any event in that exact interval.
 *      • If none match start, end, AND description(marker), create a new
 *        “Busy” event tagged with the marker.
 * @param {boolean} enableLogging  If true, logs per-calendar and per-event details.
 *                                 Always logs start and end of execution.
 */

function syncBusy(enableLogging = false) {
  const srcIds = [
    'calendar1id@...',
    'calendar2id@...'
  ];
  const destCal = CalendarApp.getCalendarById(
    'global-calendar-id@...'
  );


  // Always log execution boundaries
  Logger.log(`syncBusy STARTED at ${new Date().toISOString()}`);

  const now   = new Date();
  const later = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  srcIds.forEach(srcId => {
    if (enableLogging) {
      Logger.log(`\n🔄 Checking source calendar: ${srcId}`);
    }
    const events = CalendarApp
      .getCalendarById(srcId)
      .getEvents(now, later);
    if (enableLogging) {
      Logger.log(`Found ${events.length} event(s) in ${srcId}`);
    }

    events.forEach(e => {
      const start  = e.getStartTime().getTime();
      const end    = e.getEndTime().getTime();
      const marker = `from ${srcId}`;

      // Detect duplicates by exact start/end + marker
      const duplicate = destCal
        .getEvents(new Date(start), new Date(end))
        .some(ev =>
          ev.getStartTime().getTime() === start &&
          ev.getEndTime().getTime()   === end   &&
          ev.getDescription()         === marker
        );

      if (!duplicate) {
        if (enableLogging) {
          Logger.log(
            `✅ Syncing event: ${new Date(start).toISOString()} → ` +
            `${new Date(end).toISOString()} (${marker})`
          );
        }
        destCal.createEvent(
          'Busy',
          new Date(start),
          new Date(end),
          { description: marker }
        );
      } else if (enableLogging) {
        Logger.log(
          `⏭️ Skipping duplicate: ${new Date(start).toISOString()} → ` +
          `${new Date(end).toISOString()} (${marker})`
        );
      }
    });
  });

  Logger.log(`syncBusy FINISHED at ${new Date().toISOString()}`);
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
