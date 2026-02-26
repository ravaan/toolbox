/**
 * Calendar Sync v3.0 — Shared Helpers
 *
 * Utilities used by sync.gs, reverse-sync.gs, and booking.gs.
 * All functions are underscore-prefixed (not exposed to google.script.run).
 */

/* ═══════════════════════ EVENT FETCHING ═══════════════════════ */

/**
 * Fetch events from a calendar using the Advanced Calendar Service.
 * Falls back to CalendarApp if the Advanced Service returns 403
 * (busy-view calendars with restricted access).
 *
 * @param {string}  calendarId
 * @param {Date}    winStart
 * @param {Date}    winEnd
 * @param {boolean} enableLogging
 * @return {Array<Object>} Normalized event objects
 */
function _fetchEvents(calendarId, winStart, winEnd, enableLogging) {
  try {
    return _fetchEventsAdvanced(calendarId, winStart, winEnd);
  } catch (e) {
    if (e.message && (e.message.indexOf('403') !== -1 ||
        e.message.indexOf('Not Found') !== -1 ||
        e.message.indexOf('is not defined') !== -1)) {
      _log(enableLogging, `   ⚠ Advanced API unavailable for ${calendarId}, using CalendarApp`);
      return _fetchEventsCalendarApp(calendarId, winStart, winEnd);
    }
    throw e;
  }
}

/**
 * Fetch events using Advanced Calendar Service (Calendar API v3).
 * Always sets singleEvents=true to expand recurring events.
 *
 * @param {string} calendarId
 * @param {Date}   winStart
 * @param {Date}   winEnd
 * @return {Array<Object>} Raw API event items
 */
function _fetchEventsAdvanced(calendarId, winStart, winEnd) {
  const params = {
    timeMin: winStart.toISOString(),
    timeMax: winEnd.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 2500,
    showDeleted: false
  };

  let allItems = [];
  let pageToken = null;

  do {
    if (pageToken) params.pageToken = pageToken;
    const response = _withRetry(() => Calendar.Events.list(calendarId, params));
    allItems = allItems.concat(response.items || []);
    pageToken = response.nextPageToken || null;
  } while (pageToken);

  return allItems.map(item => _normalizeAdvancedEvent(item, calendarId));
}

/**
 * Fetch events using CalendarApp (fallback for busy-view calendars).
 *
 * @param {string} calendarId
 * @param {Date}   winStart
 * @param {Date}   winEnd
 * @return {Array<Object>} Normalized event objects
 */
function _fetchEventsCalendarApp(calendarId, winStart, winEnd) {
  const cal = CalendarApp.getCalendarById(calendarId);
  if (!cal) throw new Error(`Calendar not found: ${calendarId}`);
  const events = cal.getEvents(winStart, winEnd);

  return events.map(ev => ({
    id: ev.getId(),
    summary: ev.getTitle(),
    description: ev.getDescription(),
    start: ev.getStartTime(),
    end: ev.getEndTime(),
    iCalUID: null,
    attendees: null,
    extendedProperties: null,
    isAllDay: ev.isAllDayEvent(),
    _calendarAppEvent: ev,
    _source: 'CalendarApp'
  }));
}

/**
 * Normalize an Advanced Calendar Service event item into our standard shape.
 *
 * @param {Object} item  Raw API event item
 * @param {string} calendarId
 * @return {Object} Normalized event
 */
function _normalizeAdvancedEvent(item, calendarId) {
  const isAllDay = !!item.start.date && !item.start.dateTime;
  return {
    id: item.id,
    summary: item.summary || '',
    description: item.description || '',
    start: _getEventTime(item.start),
    end: _getEventTime(item.end),
    iCalUID: item.iCalUID || null,
    attendees: item.attendees || null,
    extendedProperties: item.extendedProperties || null,
    isAllDay: isAllDay,
    _rawStart: item.start,
    _rawEnd: item.end,
    _source: 'Advanced'
  };
}

/* ═══════════════════════ SYNC TOKEN HELPERS ═══════════════════════ */

/**
 * Check if a source calendar has changed since last sync using syncToken.
 * Returns { changed: boolean, newToken: string|null }.
 *
 * @param {string} calendarId
 * @return {{ changed: boolean, newToken: string|null }}
 */
function _hasSourceChanged(calendarId) {
  const props = PropertiesService.getScriptProperties();
  const tokenKey = `syncToken_${calendarId}`;
  const storedToken = props.getProperty(tokenKey);

  if (!storedToken) return { changed: true, newToken: null };

  try {
    const response = Calendar.Events.list(calendarId, {
      syncToken: storedToken,
      maxResults: 1,
      showDeleted: true
    });

    const items = response.items || [];
    if (items.length === 0) {
      const newToken = response.nextSyncToken || storedToken;
      if (newToken !== storedToken) {
        props.setProperty(tokenKey, newToken);
      }
      return { changed: false, newToken: newToken };
    }
    return { changed: true, newToken: null };
  } catch (e) {
    if (e.message && e.message.indexOf('410') !== -1) {
      props.deleteProperty(tokenKey);
      _log(true, `   ⚠ syncToken invalidated for ${calendarId}, will do full sync`);
    }
    return { changed: true, newToken: null };
  }
}

/**
 * Store a syncToken after a successful full fetch.
 * Performs a lightweight list call to obtain the token.
 *
 * @param {string} calendarId
 * @param {Date}   winStart
 * @param {Date}   winEnd
 */
function _storeSyncToken(calendarId, winStart, winEnd) {
  try {
    const response = Calendar.Events.list(calendarId, {
      timeMin: winStart.toISOString(),
      timeMax: winEnd.toISOString(),
      maxResults: 1,
      singleEvents: true
    });
    if (response.nextSyncToken) {
      const props = PropertiesService.getScriptProperties();
      props.setProperty(`syncToken_${calendarId}`, response.nextSyncToken);
    }
  } catch (e) {
    // Non-critical: we'll just do a full sync next time
    _log(true, `   ⚠ Could not store syncToken for ${calendarId}: ${e.message}`);
  }
}

/**
 * Check if a periodic full re-sync is needed (every 24 hours).
 * @return {boolean}
 */
function _isFullResyncDue() {
  const props = PropertiesService.getScriptProperties();
  const lastFull = props.getProperty('lastFullResync');
  if (!lastFull) return true;
  const elapsed = Date.now() - Number(lastFull);
  return elapsed > 24 * 60 * 60 * 1000;
}

/**
 * Mark the current time as the last full re-sync.
 */
function _markFullResyncDone() {
  PropertiesService.getScriptProperties().setProperty('lastFullResync', String(Date.now()));
}

/* ═══════════════════════ EVENT CREATION / DELETION ═══════════════════════ */

/**
 * Create an event on a destination calendar using Advanced Calendar Service.
 *
 * @param {string} destCalId
 * @param {string} title
 * @param {Date}   start
 * @param {Date}   end
 * @param {string} description
 * @param {string} [colorId]
 * @param {Object} [extProps]  Private extended properties
 * @param {boolean} [isAllDay]
 * @param {Object} [rawStart]  Original start object for all-day events
 * @param {Object} [rawEnd]    Original end object for all-day events
 * @return {Object} Created event
 */
function _createEvent(destCalId, title, start, end, description, colorId, extProps, isAllDay, rawStart, rawEnd) {
  const event = {
    summary: title,
    description: description,
    transparency: 'opaque'
  };

  if (isAllDay && rawStart && rawEnd) {
    event.start = { date: rawStart.date };
    event.end = { date: rawEnd.date };
  } else {
    event.start = { dateTime: start.toISOString() };
    event.end = { dateTime: end.toISOString() };
  }

  if (colorId) event.colorId = String(colorId);

  if (extProps) {
    event.extendedProperties = { private: extProps };
  }

  return _withRetry(() => Calendar.Events.insert(event, destCalId));
}

/**
 * Delete an event from a calendar using Advanced Calendar Service.
 *
 * @param {string} calendarId
 * @param {string} eventId
 */
function _deleteEvent(calendarId, eventId) {
  try {
    _withRetry(() => Calendar.Events.remove(calendarId, eventId));
  } catch (e) {
    if (e.message && e.message.indexOf('404') !== -1) {
      // Event already deleted, ignore
    } else {
      throw e;
    }
  }
}

/* ═══════════════════════ EXTENDED PROPERTIES ═══════════════════════ */

/**
 * Read extended properties from a normalized event.
 *
 * @param {Object} event  Normalized event object
 * @return {{ managedBy: string, type: string, sourceId: string }|null}
 */
function _getEventProps(event) {
  const ep = event.extendedProperties;
  if (!ep || !ep.private) return null;
  const p = ep.private;
  if (p.managedBy !== CONFIG.managedByTag) return null;
  return {
    managedBy: p.managedBy,
    type: p.type || '',
    sourceId: p.sourceId || ''
  };
}

/**
 * Check if an event is managed by this script.
 *
 * @param {Object} event  Normalized event
 * @return {boolean}
 */
function _isManagedEvent(event) {
  return _getEventProps(event) !== null;
}

/**
 * Check if an event is a forward-synced event.
 *
 * @param {Object} event  Normalized event
 * @return {boolean}
 */
function _isForwardEvent(event) {
  const props = _getEventProps(event);
  return props !== null && props.type === 'forward';
}

/**
 * Check if an event is a reverse-synced event.
 *
 * @param {Object} event  Normalized event
 * @return {boolean}
 */
function _isReverseEvent(event) {
  const props = _getEventProps(event);
  return props !== null && props.type === 'reverse';
}

/**
 * Check if an event is a booked event.
 *
 * @param {Object} event  Normalized event
 * @return {boolean}
 */
function _isBookedEvent(event) {
  const props = _getEventProps(event);
  return props !== null && props.type === 'booked';
}

/**
 * Build the extendedProperties.private object for a managed event.
 *
 * @param {string} type      "forward" | "reverse" | "booked"
 * @param {string} sourceId  Source calendar ID
 * @return {Object}
 */
function _buildExtProps(type, sourceId) {
  return {
    managedBy: CONFIG.managedByTag,
    type: type,
    sourceId: sourceId
  };
}

/* ═══════════════════════ EVENT FILTERING ═══════════════════════ */

/**
 * Check if an event should be excluded based on per-source config.
 * Excludes events where the user hasn't responded (needsAction)
 * when excludeNotResponded is true.
 *
 * @param {Object} event        Normalized event
 * @param {Object} sourceConfig Source config from CONFIG
 * @return {boolean} true if event should be excluded
 */
function _shouldExclude(event, sourceConfig) {
  if (!sourceConfig.excludeNotResponded) return false;

  const attendees = event.attendees;
  if (!attendees || !Array.isArray(attendees)) return false;

  const self = attendees.find(a => a.self === true);
  if (!self) return false;

  return self.responseStatus === 'needsAction';
}

/* ═══════════════════════ DEDUPLICATION ═══════════════════════ */

/**
 * Deduplicate events across sources using iCalUID + startTime composite key.
 *
 * When the same event appears on multiple source calendars (same meeting),
 * keep only the best representative:
 *   1. Prefer source with a real title (not "Busy" or empty)
 *   2. Prefer source where user accepted the event
 *   3. Prefer source with lower CONFIG index (earlier in array)
 *
 * @param {Array<{ sourceConfig: Object, sourceIndex: number, events: Array<Object> }>} eventsBySource
 * @return {Array<{ event: Object, sourceConfig: Object }>}
 */
function _deduplicateByICalUID(eventsBySource) {
  const byCompositeKey = new Map();
  const noUID = [];

  eventsBySource.forEach(({ sourceConfig, sourceIndex, events }) => {
    events.forEach(event => {
      const uid = event.iCalUID;
      const startMs = event.start ? event.start.getTime() : 0;

      if (!uid) {
        noUID.push({ event, sourceConfig });
        return;
      }

      const compositeKey = `${uid}|${startMs}`;
      if (!byCompositeKey.has(compositeKey)) {
        byCompositeKey.set(compositeKey, []);
      }
      byCompositeKey.get(compositeKey).push({ event, sourceConfig, sourceIndex });
    });
  });

  const deduped = [];

  for (const [, candidates] of byCompositeKey) {
    if (candidates.length === 1) {
      deduped.push(candidates[0]);
      continue;
    }

    candidates.sort((a, b) => {
      const aTitle = _hasRealTitle(a.event) ? 0 : 1;
      const bTitle = _hasRealTitle(b.event) ? 0 : 1;
      if (aTitle !== bTitle) return aTitle - bTitle;

      const aAccepted = _isUserAccepted(a.event) ? 0 : 1;
      const bAccepted = _isUserAccepted(b.event) ? 0 : 1;
      if (aAccepted !== bAccepted) return aAccepted - bAccepted;

      return a.sourceIndex - b.sourceIndex;
    });

    deduped.push(candidates[0]);
  }

  return deduped.concat(noUID);
}

function _hasRealTitle(event) {
  const s = (event.summary || '').trim();
  return s !== '' && s.toLowerCase() !== 'busy';
}

function _isUserAccepted(event) {
  const attendees = event.attendees;
  if (!attendees || !Array.isArray(attendees)) return false;
  const self = attendees.find(a => a.self === true);
  return self && self.responseStatus === 'accepted';
}

/* ═══════════════════════ EVENT TITLE / KEY BUILDING ═══════════════════════ */

/**
 * Build the display title for a destination event.
 *
 * @param {Object} event        Normalized event
 * @param {Object} sourceConfig Source config from CONFIG
 * @return {string}
 */
function _buildEventTitle(event, sourceConfig) {
  const summary = (event.summary || '').trim();
  const nickname = sourceConfig.nickname || sourceConfig.id;

  if (sourceConfig.showTitle && summary && summary.toLowerCase() !== 'busy') {
    return `Busy - ${summary}`;
  }
  return `Busy (${nickname})`;
}

/**
 * Build a unique key for matching source events to destination events.
 * Format: "startMs|endMs|sourceCalendarId"
 *
 * @param {Date}   start
 * @param {Date}   end
 * @param {string} marker  Typically the source calendar ID
 * @return {string}
 */
function _buildKey(start, end, marker) {
  return `${start.getTime()}|${end.getTime()}|${marker}`;
}

/* ═══════════════════════ TIME HELPERS ═══════════════════════ */

/**
 * Convert look-ahead days to [start, end] Date objects.
 * @param {number} days
 * @return {[Date, Date]}
 */
function _getWindowBounds(days) {
  const start = new Date();
  const end = new Date(start.getTime() + days * 86400000);
  return [start, end];
}

/**
 * Parse a Calendar API time object (handles both dateTime and date formats).
 *
 * @param {Object} timeObj  { dateTime: "..." } or { date: "2026-02-26" }
 * @return {Date}
 */
function _getEventTime(timeObj) {
  if (!timeObj) return new Date(0);
  if (timeObj.dateTime) return new Date(timeObj.dateTime);
  if (timeObj.date) return new Date(timeObj.date + 'T00:00:00');
  return new Date(0);
}

/* ═══════════════════════ RETRY / LOGGING ═══════════════════════ */

/**
 * Retry a function with exponential backoff on rate-limit errors.
 *
 * @param {Function} fn         Function to execute
 * @param {number}   [maxRetries=3]
 * @return {*} Return value of fn
 */
function _withRetry(fn, maxRetries) {
  maxRetries = maxRetries || 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt === maxRetries) throw e;
      const msg = e.message || '';
      if (msg.indexOf('403') !== -1 || msg.indexOf('429') !== -1 ||
          msg.indexOf('Rate Limit') !== -1) {
        const wait = Math.pow(2, attempt) * 1000 + Math.floor(Math.random() * 1000);
        Utilities.sleep(Math.min(wait, 10000));
      } else {
        throw e;
      }
    }
  }
}

/** Conditional logger. */
function _log(enabled, msg) {
  if (enabled) Logger.log(msg);
}

/* ═══════════════════════ EXECUTION TIME GUARD ═══════════════════════ */

const _EXEC_START = Date.now();
const _EXEC_LIMIT_MS = 5 * 60 * 1000;

/**
 * Check if we're approaching the 6-minute execution limit.
 * Returns true if more than 5 minutes have elapsed.
 * @return {boolean}
 */
function _isNearTimeLimit() {
  return (Date.now() - _EXEC_START) > _EXEC_LIMIT_MS;
}

/* ═══════════════════════ PURGE UTILITY ═══════════════════════ */

/**
 * Purge future events from a destination calendar.
 * Reads calendar ID from CONFIG. Aware of event types (forward, reverse, booked).
 *
 * @param {Object}  [opts]
 * @param {number}  [opts.destIndex=0]    Index into CONFIG.destinationCalendars
 * @param {string}  [opts.destId]         Explicit calendar ID (overrides destIndex)
 * @param {boolean} [opts.deleteFlag=false]  true=delete, false=dry-run (list only)
 * @param {boolean} [opts.clearTokens=false] Also clear syncTokens for this dest's sources
 */
function purgeFutureEvents(opts) {
  opts = opts || {};
  const deleteFlag = opts.deleteFlag === true;
  const clearTokens = opts.clearTokens === true;

  var calendarId, destConfig;
  if (opts.destId) {
    calendarId = opts.destId;
    destConfig = CONFIG.destinationCalendars.find(function(d) { return d.id === calendarId; });
  } else {
    var idx = opts.destIndex || 0;
    destConfig = CONFIG.destinationCalendars[idx];
    if (!destConfig) {
      Logger.log('No destination at index ' + idx);
      return;
    }
    calendarId = destConfig.id;
  }

  Logger.log('Target: ' + (destConfig ? destConfig.label : calendarId));
  Logger.log('Mode: ' + (deleteFlag ? 'DELETE' : 'DRY RUN (list only)'));

  var now = new Date();
  var allEvents = [];
  var pageToken = null;

  do {
    var params = {
      timeMin: now.toISOString(),
      singleEvents: true,
      maxResults: 2500,
      orderBy: 'startTime'
    };
    if (pageToken) params.pageToken = pageToken;
    var response = Calendar.Events.list(calendarId, params);
    allEvents = allEvents.concat(response.items || []);
    pageToken = response.nextPageToken || null;
  } while (pageToken);

  Logger.log('Found ' + allEvents.length + ' future event(s)');

  var counts = { forward: 0, reverse: 0, booked: 0, unmanaged: 0 };

  allEvents.forEach(function(ev) {
    var ep = ev.extendedProperties && ev.extendedProperties.private;
    var type = 'unmanaged';
    if (ep && ep.managedBy === CONFIG.managedByTag) {
      type = ep.type || 'forward';
    }
    counts[type] = (counts[type] || 0) + 1;

    var startStr = ev.start.dateTime || ev.start.date || '?';
    var endStr = ev.end.dateTime || ev.end.date || '?';

    if (deleteFlag) {
      try {
        Calendar.Events.remove(calendarId, ev.id);
      } catch (e) {
        Logger.log('  Failed to delete ' + ev.id + ': ' + e.message);
      }
    } else {
      Logger.log('[' + type.toUpperCase() + '] ' + startStr + ' -> ' + endStr +
        ' | "' + (ev.summary || '') + '" | desc: "' + (ev.description || '').substring(0, 50) + '"');
    }
  });

  Logger.log('Counts: forward=' + counts.forward + ', reverse=' + counts.reverse +
    ', booked=' + counts.booked + ', unmanaged=' + counts.unmanaged);

  if (clearTokens) {
    var props = PropertiesService.getScriptProperties();
    if (destConfig && destConfig.sources) {
      destConfig.sources.forEach(function(src) {
        var srcId = typeof src === 'string' ? src : src.id;
        props.deleteProperty('syncToken_' + srcId);
        Logger.log('Cleared syncToken for ' + srcId);
      });
    }
    props.deleteProperty('syncToken_' + calendarId);
    props.deleteProperty('lastFullResync');
    Logger.log('Cleared syncToken for dest ' + calendarId + ' and reset full-resync timer');
  }

  Logger.log('Purge complete. ' + (deleteFlag ? 'Deleted' : 'Listed') + ' ' + allEvents.length + ' events.');
}
