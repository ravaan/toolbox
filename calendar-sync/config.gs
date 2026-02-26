/**
 * Calendar Sync v3.0 — Configuration
 *
 * All calendar IDs, source settings, reverse-sync targets,
 * and booking page options are defined here.
 *
 * Google Calendar event color reference:
 *   "1"  Lavender     "2"  Sage        "3"  Grape
 *   "4"  Flamingo     "5"  Banana      "6"  Tangerine
 *   "7"  Peacock      "8"  Graphite    "9"  Blueberry
 *   "10" Basil        "11" Tomato
 */

const CONFIG = {
  /** Default look-ahead window (days). Incremental sync makes 90 feasible. */
  lookAheadDays: 90,

  /** Tag used in extendedProperties.private to identify script-managed events */
  managedByTag: 'calendar-sync',

  /**
   * Destination calendars (processed top-to-bottom).
   *
   * Each destination has:
   *   id              — calendar ID
   *   label           — human-readable name for logs
   *   lookAheadDays   — optional override of global window
   *   sources[]       — array of source calendar configs
   *   reverseSync     — optional reverse-sync configuration
   *
   * Each source has:
   *   id                   — calendar ID
   *   nickname             — short label used in event titles and logs
   *   colorId              — Google Calendar color "1"-"11"
   *   showTitle            — include source event title when accessible
   *   excludeNotResponded  — skip events where user hasn't responded (needsAction)
   */
  destinationCalendars: [
    {
      id: '7c2bef9af5906f0995a42299583180d22fa42e178ede897b31c0fcad28fcfc68@group.calendar.google.com',
      label: 'Personal Aggregate',
      lookAheadDays: 90,
      sources: [
        {
          id: 'arpit.agarwal181@gmail.com',
          nickname: 'Personal',
          colorId: '9',
          showTitle: true,
          excludeNotResponded: true
        },
        {
          id: 'a.agarwal@roqit.com',
          nickname: 'Roqit',
          colorId: '6',
          showTitle: false,
          excludeNotResponded: false
        },
        {
          id: 'content.ai@klydo.in',
          nickname: 'Klydo',
          colorId: '3',
          showTitle: false,
          excludeNotResponded: false
        },
        {
          id: 'arpit@studiotypo.xyz',
          nickname: 'Studio',
          colorId: '10',
          showTitle: true,
          excludeNotResponded: true
        }
      ],
      reverseSync: {
        enabled: true,
        targets: [
          'arpit.agarwal181@gmail.com',
          'arpit@studiotypo.xyz'
        ]
      }
    },
    {
      id: '45b0059043aae6bc36a1122027d6386f339481fb324a08482e352a62e8849bc5@group.calendar.google.com',
      label: 'Shared Partner View',
      lookAheadDays: 90,
      sources: [
        {
          id: '7c2bef9af5906f0995a42299583180d22fa42e178ede897b31c0fcad28fcfc68@group.calendar.google.com',
          nickname: 'My Calendar',
          colorId: '7',
          showTitle: false,
          excludeNotResponded: false
        },
        {
          id: '0c468c863935443f174faab4b7610fd40a88160c7e60062713bff4e8a909dc6c@group.calendar.google.com',
          nickname: 'Partner',
          colorId: '2',
          showTitle: false,
          excludeNotResponded: false
        }
      ]
    }
  ],

  /** Booking page configuration */
  booking: {
    enabled: true,
    aggregateCalendarId: '7c2bef9af5906f0995a42299583180d22fa42e178ede897b31c0fcad28fcfc68@group.calendar.google.com',
    pageTitle: 'Book a Meeting',
    ownerTimezone: 'Asia/Kolkata',
    workingHours: {
      start: 9,
      end: 18,
      days: [1, 2, 3, 4, 5]
    },
    slotDurationMinutes: 30,
    lookAheadDays: 14
  }
};
