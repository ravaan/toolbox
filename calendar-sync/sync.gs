/**
 * Calendar Sync v3.0 — Forward Sync
 *
 * Mirrors busy blocks from source calendars into destination calendars.
 * Uses Advanced Calendar Service with syncToken-based change detection.
 *
 * Key safety features:
 *   - Cleanup only deletes events tagged as type="forward" (not manual/booked/reverse)
 *   - Source collection skips events tagged as type="reverse" or type="booked"
 *   - Cross-source dedup using iCalUID + startTime composite key
 *   - Per-source filtering of not-responded events
 *   - Time guard at 5 minutes to avoid 6-minute execution limit
 */

/* ─────────────────────── PUBLIC ENTRY ─────────────────────── */

/**
 * Forward sync entry point. Processes each destination calendar.
 *
 * @param {Object}  [opts]
 * @param {boolean} [opts.enableLogging=false]
 * @param {number}  [opts.lookAheadDays]       Override global default
 * @param {boolean} [opts.forceFullSync=false]  Skip syncToken optimization
 */
function syncBusyCalendars(opts) {
  opts = opts || {};
  var enableLogging = opts.enableLogging === true;
  var defaultLookAheadDays = opts.lookAheadDays || CONFIG.lookAheadDays;
  var forceFullSync = opts.forceFullSync === true || _isFullResyncDue();

  if (forceFullSync) {
    _log(enableLogging, '   Full re-sync triggered (periodic or forced)');
    _markFullResyncDone();
  }

  CONFIG.destinationCalendars.forEach(function(dest, idx) {
    if (_isNearTimeLimit()) {
      _log(true, '⏰ Near time limit, stopping before dest #' + (idx + 1));
      return;
    }

    if (!dest.sources || !dest.sources.length) {
      _log(true, '⚠️  DEST SKIPPED (#' + (idx + 1) + ' — ' + dest.id + '): no sources configured');
      return;
    }

    var lookAheadDays = dest.lookAheadDays || defaultLookAheadDays;
    var bounds = _getWindowBounds(lookAheadDays);
    var winStart = bounds[0];
    var winEnd = bounds[1];
    _log(enableLogging, '\n🚀 FWD START (#' + (idx + 1) + ') ' +
      (dest.label || dest.id) + ' — ' + winStart.toDateString() + ' → ' + winEnd.toDateString());

    var destSources = dest.sources.map(function(src) {
      return typeof src === 'string' ? { id: src, nickname: src, showTitle: false, excludeNotResponded: false } : src;
    });

    // Determine which sources are reverse-sync targets (always full fetch)
    var reverseTargets = new Set();
    if (dest.reverseSync && dest.reverseSync.targets) {
      dest.reverseSync.targets.forEach(function(t) { reverseTargets.add(t); });
    }

    var collected = _collectSourceEvents(destSources, winStart, winEnd,
      enableLogging, forceFullSync, reverseTargets);

    var summary = { created: 0, deleted: 0 };
    try {
      summary = _syncDestination(dest, collected.dedupedEvents,
        collected.sourceKeys, winStart, winEnd, enableLogging);
      _log(enableLogging, '   ↳ Summary: +' + summary.created + ' / -' + summary.deleted);
    } catch (e) {
      _log(true, '❌ DEST ERROR (' + (dest.label || dest.id) + '): ' + e.message);
    }
  });

  _log(enableLogging, '\n✅ Forward sync done');
}

/* ─────────────────────── CORE SYNC LOGIC ─────────────────────── */

/**
 * Two-phase sync for one destination.
 *
 * Phase 1 (Cleanup): Delete forward-synced events that no longer match any source event.
 *   SAFETY: Only touches events with extendedProperties.private.type === "forward".
 *   Manual events, booked events, and reverse-synced events are untouched.
 *
 * Phase 2 (Addition): Create events for source entries not yet in the destination.
 *
 * @param {Object}              dest
 * @param {Array<Object>}       dedupedEvents  Array of { event, sourceConfig, key, title, marker }
 * @param {Set<string>}         sourceKeys
 * @param {Date}                winStart
 * @param {Date}                winEnd
 * @param {boolean}             enableLogging
 * @return {{ created: number, deleted: number }}
 */
function _syncDestination(dest, dedupedEvents, sourceKeys, winStart, winEnd, enableLogging) {
  // Fetch all destination events
  var destEvents = _fetchEvents(dest.id, winStart, winEnd, enableLogging);
  _log(enableLogging, '   ↳ Loaded ' + destEvents.length + ' dest events');

  // Build key set for existing FORWARD events on destination
  var destForwardKeys = new Map(); // key -> { event }
  destEvents.forEach(function(ev) {
    if (!_isForwardEvent(ev)) return;
    var props = _getEventProps(ev);
    var key = _buildKey(ev.start, ev.end, props.sourceId);
    destForwardKeys.set(key, ev);
  });

  /* Phase 1 — CLEANUP: delete stale forward-synced events */
  var deleted = 0;
  for (var entry of destForwardKeys) {
    var key = entry[0];
    var ev = entry[1];
    if (_isNearTimeLimit()) {
      _log(true, '⏰ Near time limit during cleanup, stopping');
      break;
    }
    if (!sourceKeys.has(key)) {
      _deleteEvent(dest.id, ev.id);
      deleted++;
      _log(enableLogging, '   🗑️ Deleted: ' + ev.start + ' — ' + ev.end +
        ' (' + (ev.summary || '') + ')');
    }
  }

  /* Phase 2 — ADDITION: create missing events */
  var created = 0;
  dedupedEvents.forEach(function(item) {
    if (_isNearTimeLimit()) {
      _log(true, '⏰ Near time limit during creation, stopping');
      return;
    }
    if (destForwardKeys.has(item.key)) return;

    _createEvent(
      dest.id,
      item.title,
      item.event.start,
      item.event.end,
      item.sourceConfig.nickname || item.sourceConfig.id,
      item.sourceConfig.colorId,
      _buildExtProps('forward', item.sourceConfig.id),
      item.event.isAllDay,
      item.event._rawStart,
      item.event._rawEnd
    );
    created++;
    _log(enableLogging, '   ✅ Created: ' + item.event.start + ' — ' + item.event.end +
      ' (' + item.title + ')');
  });

  return { created: created, deleted: deleted };
}

/* ─────────────────────── SOURCE COLLECTION ─────────────────────── */

/**
 * Collect, filter, and deduplicate events from all source calendars.
 *
 * @param {Array<Object>}  srcConfigs       Source config objects
 * @param {Date}           winStart
 * @param {Date}           winEnd
 * @param {boolean}        enableLogging
 * @param {boolean}        forceFullSync
 * @param {Set<string>}    reverseTargets   Calendar IDs that are reverse-sync targets
 * @return {{ dedupedEvents: Array<Object>, sourceKeys: Set<string> }}
 */
function _collectSourceEvents(srcConfigs, winStart, winEnd, enableLogging, forceFullSync, reverseTargets) {
  var eventsBySource = [];

  srcConfigs.forEach(function(srcConfig, srcIndex) {
    if (_isNearTimeLimit()) {
      _log(true, '⏰ Near time limit, skipping remaining sources');
      return;
    }

    var calId = srcConfig.id;

    // syncToken change detection (skip if nothing changed)
    var isReverseTarget = reverseTargets && reverseTargets.has(calId);
    if (!forceFullSync && !isReverseTarget) {
      try {
        var changeCheck = _hasSourceChanged(calId);
        if (!changeCheck.changed) {
          _log(enableLogging, '   • ' + (srcConfig.nickname || calId) + ': no changes (skipped)');
          return;
        }
      } catch (e) {
        // If change detection fails, proceed with full fetch
        _log(enableLogging, '   ⚠ Change detection failed for ' + calId + ', doing full fetch');
      }
    }

    try {
      var events = _fetchEvents(calId, winStart, winEnd, enableLogging);
      _log(enableLogging, '   • Pulled ' + events.length + ' event(s) from ' + (srcConfig.nickname || calId));

      // Filter out reverse-synced and booked events (prevent sync loops)
      var filtered = events.filter(function(ev) {
        if (_isReverseEvent(ev) || _isBookedEvent(ev)) return false;
        if (_shouldExclude(ev, srcConfig)) return false;
        return true;
      });

      _log(enableLogging, '   • After filtering: ' + filtered.length + ' event(s)');

      eventsBySource.push({
        sourceConfig: srcConfig,
        sourceIndex: srcIndex,
        events: filtered
      });

      // Store syncToken for next run
      _storeSyncToken(calId, winStart, winEnd);

    } catch (e) {
      _log(true, '❌ SRC ERROR (' + (srcConfig.nickname || calId) + '): ' + e.message);
    }
  });

  // Cross-source dedup using iCalUID + startTime
  var deduped = _deduplicateByICalUID(eventsBySource);
  _log(enableLogging, '   ↳ After dedup: ' + deduped.length + ' unique events');

  // Build final event list with keys
  var dedupedEvents = [];
  var sourceKeys = new Set();

  deduped.forEach(function(item) {
    var title = _buildEventTitle(item.event, item.sourceConfig);
    var key = _buildKey(item.event.start, item.event.end, item.sourceConfig.id);

    dedupedEvents.push({
      event: item.event,
      sourceConfig: item.sourceConfig,
      key: key,
      title: title
    });
    sourceKeys.add(key);
  });

  _log(enableLogging, '   ↳ Total source events for destination: ' + dedupedEvents.length);
  return { dedupedEvents: dedupedEvents, sourceKeys: sourceKeys };
}
