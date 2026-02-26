/**
 * Calendar Sync v3.0 — Booking Page (Server-Side)
 *
 * Serves a simple booking page via HtmlService where visitors
 * can see available time slots and book meetings.
 *
 * Security:
 *   - Deployed as "Execute as me" + "Anyone with Google Account"
 *   - All internal helpers are underscore-prefixed (not exposed to google.script.run)
 *   - Booking creates events with type="booked" extendedProperties
 *   - LockService prevents double-booking
 *
 * Only these functions are callable from the client:
 *   - doGet(e)
 *   - getAvailableSlots(timezone, startDate, endDate)
 *   - bookSlot(slotStart, slotEnd, name, email, timezone)
 */

/* ─────────────────────── WEB APP ENTRY ─────────────────────── */

/**
 * Serves the booking page HTML.
 */
function doGet(e) {
  if (!CONFIG.booking || !CONFIG.booking.enabled) {
    return HtmlService.createHtmlOutput('<h1>Booking is currently disabled.</h1>');
  }

  var output = HtmlService.createHtmlOutputFromFile('booking')
    .setTitle(CONFIG.booking.pageTitle || 'Book a Meeting')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  return output;
}

/* ─────────────────────── PUBLIC API (callable from client) ─────────────────────── */

/**
 * Get available time slots for the booking page.
 *
 * @param {string} timezone   IANA timezone (e.g., 'Asia/Kolkata')
 * @param {string} startDate  ISO date string
 * @param {string} endDate    ISO date string
 * @return {Array<{ date: string, dayLabel: string, slots: Array<{ start: string, end: string, label: string }> }>}
 */
function getAvailableSlots(timezone, startDate, endDate) {
  var bookingCfg = CONFIG.booking;
  if (!bookingCfg || !bookingCfg.enabled) return [];

  var calendarIds = _getAllBookingCalendarIds();
  var busyPeriods = _queryFreeBusy(calendarIds, startDate, endDate, timezone);
  var slots = _generateFreeSlots(
    new Date(startDate),
    new Date(endDate),
    busyPeriods,
    bookingCfg.ownerTimezone,
    bookingCfg.workingHours,
    bookingCfg.slotDurationMinutes,
    timezone
  );

  return slots;
}

/**
 * Book a time slot. Re-checks availability to prevent double-booking.
 *
 * @param {string} slotStart  ISO datetime
 * @param {string} slotEnd    ISO datetime
 * @param {string} name       Booker's name
 * @param {string} email      Booker's email
 * @param {string} timezone   Booker's IANA timezone
 * @return {{ success: boolean, message: string }}
 */
function bookSlot(slotStart, slotEnd, name, email, timezone) {
  var bookingCfg = CONFIG.booking;
  if (!bookingCfg || !bookingCfg.enabled) {
    return { success: false, message: 'Booking is currently disabled.' };
  }

  if (!name || !email || !slotStart || !slotEnd) {
    return { success: false, message: 'Please fill in all fields.' };
  }

  if (!_isValidEmail(email)) {
    return { success: false, message: 'Please enter a valid email address.' };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    return { success: false, message: 'Server is busy. Please try again in a moment.' };
  }

  try {
    // Re-check availability
    var calendarIds = _getAllBookingCalendarIds();
    var busyPeriods = _queryFreeBusy(calendarIds, slotStart, slotEnd, timezone);

    var startMs = new Date(slotStart).getTime();
    var endMs = new Date(slotEnd).getTime();
    var isStillFree = !busyPeriods.some(function(bp) {
      return startMs < bp.end && endMs > bp.start;
    });

    if (!isStillFree) {
      return {
        success: false,
        message: 'This slot is no longer available. Please select another time.'
      };
    }

    // Create event on aggregate calendar
    var aggregateCalId = bookingCfg.aggregateCalendarId;
    var eventTitle = 'Meeting with ' + name;
    var description = 'Booked by: ' + name + '\nEmail: ' + email + '\nTimezone: ' + timezone;

    _createEvent(
      aggregateCalId,
      eventTitle,
      new Date(slotStart),
      new Date(slotEnd),
      description,
      null,
      _buildExtProps('booked', aggregateCalId),
      false,
      null,
      null
    );

    var startDisplay = Utilities.formatDate(new Date(slotStart), timezone, 'EEE, MMM d, yyyy h:mm a');
    var endDisplay = Utilities.formatDate(new Date(slotEnd), timezone, 'h:mm a');

    return {
      success: true,
      message: 'Meeting booked for ' + startDisplay + ' - ' + endDisplay + ' (' + timezone + ')'
    };

  } catch (e) {
    _log(true, '❌ BOOKING ERROR: ' + e.message);
    return { success: false, message: 'An error occurred. Please try again.' };
  } finally {
    lock.releaseLock();
  }
}

/* ─────────────────────── INTERNAL HELPERS ─────────────────────── */

/**
 * Get all calendar IDs to check for free/busy (all sources + destinations).
 * @return {Array<string>}
 */
function _getAllBookingCalendarIds() {
  var ids = new Set();
  CONFIG.destinationCalendars.forEach(function(dest) {
    ids.add(dest.id);
    if (dest.sources) {
      dest.sources.forEach(function(src) {
        ids.add(typeof src === 'string' ? src : src.id);
      });
    }
  });
  return Array.from(ids);
}

/**
 * Query Calendar.Freebusy for busy periods across all calendars.
 *
 * @param {Array<string>} calendarIds
 * @param {string}        timeMin  ISO datetime
 * @param {string}        timeMax  ISO datetime
 * @param {string}        timezone IANA timezone
 * @return {Array<{ start: number, end: number }>}  Merged busy periods in ms
 */
function _queryFreeBusy(calendarIds, timeMin, timeMax, timezone) {
  var request = {
    timeMin: timeMin,
    timeMax: timeMax,
    timeZone: timezone,
    items: calendarIds.map(function(id) { return { id: id }; })
  };

  var response = Calendar.Freebusy.query(request);
  var allBusy = [];

  calendarIds.forEach(function(id) {
    var calData = response.calendars[id];
    if (calData && calData.busy) {
      calData.busy.forEach(function(period) {
        allBusy.push({
          start: new Date(period.start).getTime(),
          end: new Date(period.end).getTime()
        });
      });
    }
  });

  // Sort and merge overlapping intervals
  allBusy.sort(function(a, b) { return a.start - b.start; });
  var merged = [];
  allBusy.forEach(function(period) {
    if (merged.length === 0 || period.start > merged[merged.length - 1].end) {
      merged.push({ start: period.start, end: period.end });
    } else {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, period.end);
    }
  });

  return merged;
}

/**
 * Generate free time slots within working hours, excluding busy periods.
 *
 * @param {Date}   rangeStart
 * @param {Date}   rangeEnd
 * @param {Array}  busyPeriods     Merged busy intervals
 * @param {string} ownerTimezone   Owner's IANA timezone
 * @param {Object} workingHours    { start, end, days }
 * @param {number} slotDuration    Minutes
 * @param {string} visitorTimezone Visitor's IANA timezone
 * @return {Array<Object>}
 */
function _generateFreeSlots(rangeStart, rangeEnd, busyPeriods, ownerTimezone,
                            workingHours, slotDuration, visitorTimezone) {
  var results = [];
  var slotMs = slotDuration * 60 * 1000;
  var current = new Date(rangeStart);
  var maxDays = 60;

  for (var d = 0; d < maxDays && current < rangeEnd; d++) {
    var dayStr = Utilities.formatDate(current, ownerTimezone, 'yyyy-MM-dd');
    var dayOfWeek = Number(Utilities.formatDate(current, ownerTimezone, 'u')); // 1=Mon, 7=Sun

    if (workingHours.days.indexOf(dayOfWeek) === -1) {
      current = _addDaysToDate(current, 1);
      continue;
    }

    // Working hours in owner's timezone
    var dayStartStr = dayStr + 'T' + _padTime(workingHours.start) + ':00:00';
    var dayEndStr = dayStr + 'T' + _padTime(workingHours.end) + ':00:00';

    var dayStart = Utilities.parseDate(dayStartStr, ownerTimezone, "yyyy-MM-dd'T'HH:mm:ss");
    var dayEnd = Utilities.parseDate(dayEndStr, ownerTimezone, "yyyy-MM-dd'T'HH:mm:ss");

    var daySlots = [];
    var slotStart = dayStart.getTime();

    while (slotStart + slotMs <= dayEnd.getTime()) {
      var slotEnd = slotStart + slotMs;

      // Skip past slots
      if (slotStart > Date.now()) {
        var isBusy = busyPeriods.some(function(bp) {
          return slotStart < bp.end && slotEnd > bp.start;
        });

        if (!isBusy) {
          var slotStartDate = new Date(slotStart);
          var slotEndDate = new Date(slotEnd);
          daySlots.push({
            start: slotStartDate.toISOString(),
            end: slotEndDate.toISOString(),
            label: Utilities.formatDate(slotStartDate, visitorTimezone, 'h:mm a') +
              ' - ' + Utilities.formatDate(slotEndDate, visitorTimezone, 'h:mm a')
          });
        }
      }

      slotStart += slotMs;
    }

    if (daySlots.length > 0) {
      results.push({
        date: dayStr,
        dayLabel: Utilities.formatDate(dayStart, visitorTimezone, 'EEE, MMM d'),
        slots: daySlots
      });
    }

    current = _addDaysToDate(current, 1);
  }

  return results;
}

function _addDaysToDate(date, days) {
  var d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function _padTime(hour) {
  return String(hour).padStart(2, '0');
}

function _isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
