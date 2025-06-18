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
 */

function syncBusy() {
  const srcIds = [
    'calendar1id@...',
    'calendar2id@...'
  ];
  const destCal = CalendarApp.getCalendarById(
    'global-calendar-id@...'
  );

  const now   = new Date();
  const later = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  srcIds.forEach(srcId => {
    const events = CalendarApp
      .getCalendarById(srcId)
      .getEvents(now, later);

    events.forEach(e => {
      const start = e.getStartTime().getTime();
      const end   = e.getEndTime().getTime();
      const marker = `from ${srcId}`;

      // find any destCal event with same start, end, and description
      const duplicate = destCal
        .getEvents(new Date(start), new Date(end))
        .some(ev =>
          ev.getStartTime().getTime() === start &&
          ev.getEndTime().getTime()   === end &&
          ev.getDescription()         === marker
        );

      if (!duplicate) {
        destCal.createEvent(
          'Busy',
          new Date(start),
          new Date(end),
          { description: marker }
        );
      }
    });
  });
}
