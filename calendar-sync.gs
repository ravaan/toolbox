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
