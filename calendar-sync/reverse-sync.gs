/**
 * Calendar Sync v3.0 — Reverse Sync
 *
 * Pushes manually-created and booked events from aggregate calendars
 * back to writable source calendars (personal gmail + studio).
 *
 * Candidates for reverse sync:
 *   - Events NOT managed by this script (user-created manual events)
 *   - Events with type="booked" (created by the booking page)
 *
 * NOT candidates:
 *   - Events with type="forward" (created by forward sync)
 *   - Events with type="reverse" (already reverse-synced)
 *
 * Runs BEFORE forward sync in the orchestrator to ensure forward sync
 * sees the latest state of source calendars.
 */

/* ─────────────────────── PUBLIC ENTRY ─────────────────────── */

/**
 * Reverse sync entry point. Processes each destination that has
 * reverseSync.enabled = true.
 *
 * @param {Object}  [opts]
 * @param {boolean} [opts.enableLogging=false]
 */
function reverseSyncCalendars(opts) {
  opts = opts || {};
  var enableLogging = opts.enableLogging === true;

  CONFIG.destinationCalendars.forEach(function(dest, idx) {
    if (_isNearTimeLimit()) {
      _log(true, '⏰ Near time limit, stopping reverse sync');
      return;
    }

    if (!dest.reverseSync || !dest.reverseSync.enabled) return;

    var targets = dest.reverseSync.targets;
    if (!targets || !targets.length) return;

    var lookAheadDays = dest.reverseSync.lookAheadDays || dest.lookAheadDays || CONFIG.lookAheadDays;
    var bounds = _getWindowBounds(lookAheadDays);
    var winStart = bounds[0];
    var winEnd = bounds[1];

    _log(enableLogging, '\n🔄 REV START (#' + (idx + 1) + ') ' + (dest.label || dest.id));

    // Collect reverse-sync candidates from the aggregate calendar
    var candidates;
    try {
      candidates = _collectReverseCandidates(dest.id, winStart, winEnd, enableLogging);
    } catch (e) {
      _log(true, '❌ REV ERROR reading aggregate (' + (dest.label || dest.id) + '): ' + e.message);
      return;
    }

    _log(enableLogging, '   ↳ Found ' + candidates.events.length + ' reverse-sync candidates');

    // Push to each writable target
    targets.forEach(function(targetId) {
      if (_isNearTimeLimit()) {
        _log(true, '⏰ Near time limit, stopping reverse sync targets');
        return;
      }

      try {
        var result = _syncReverseTarget(dest.id, targetId, candidates, winStart, winEnd, enableLogging);
        _log(enableLogging, '   → ' + targetId + ': +' + result.created + ' / -' + result.deleted);
      } catch (e) {
        _log(true, '❌ REV TARGET ERROR (' + targetId + '): ' + e.message);
      }
    });
  });

  _log(enableLogging, '\n✅ Reverse sync done');
}

/* ─────────────────────── CANDIDATE COLLECTION ─────────────────────── */

/**
 * Collect events from the aggregate calendar that should be reverse-synced.
 *
 * Candidates are:
 *   - Events NOT managed by this script (no managedBy tag = user-created)
 *   - Events with type="booked" (from booking page)
 *
 * NOT candidates:
 *   - Events with type="forward" (from forward sync)
 *   - Events with type="reverse" (already reverse-synced)
 *
 * @param {string}  aggregateCalId
 * @param {Date}    winStart
 * @param {Date}    winEnd
 * @param {boolean} enableLogging
 * @return {{ events: Array<Object>, keys: Set<string> }}
 */
function _collectReverseCandidates(aggregateCalId, winStart, winEnd, enableLogging) {
  var allEvents = _fetchEvents(aggregateCalId, winStart, winEnd, enableLogging);

  var candidateEvents = [];
  var candidateKeys = new Set();

  allEvents.forEach(function(ev) {
    var props = _getEventProps(ev);

    if (props !== null) {
      // Managed event — only booked events are candidates
      if (props.type === 'forward' || props.type === 'reverse') return;
      if (props.type === 'booked') {
        // Booked events are candidates
        var key = _buildKey(ev.start, ev.end, aggregateCalId);
        candidateEvents.push({ event: ev, key: key });
        candidateKeys.add(key);
        return;
      }
    }

    // Unmanaged event (manually created by user) — is a candidate
    var key = _buildKey(ev.start, ev.end, aggregateCalId);
    candidateEvents.push({ event: ev, key: key });
    candidateKeys.add(key);
  });

  return { events: candidateEvents, keys: candidateKeys };
}

/* ─────────────────────── TARGET SYNC ─────────────────────── */

/**
 * Sync reverse candidates to one target calendar.
 * Two-phase: cleanup stale reverse events, then create missing ones.
 *
 * Only manages events tagged as type="reverse" with sourceId matching
 * the aggregate calendar. Never touches other events on the target.
 *
 * @param {string}   aggregateCalId
 * @param {string}   targetCalId
 * @param {Object}   candidates  { events, keys }
 * @param {Date}     winStart
 * @param {Date}     winEnd
 * @param {boolean}  enableLogging
 * @return {{ created: number, deleted: number }}
 */
function _syncReverseTarget(aggregateCalId, targetCalId, candidates, winStart, winEnd, enableLogging) {
  var targetEvents = _fetchEvents(targetCalId, winStart, winEnd, enableLogging);

  // Find existing reverse events WE created on the target
  var existingReverseKeys = new Map(); // key -> event
  targetEvents.forEach(function(ev) {
    var props = _getEventProps(ev);
    if (!props || props.type !== 'reverse' || props.sourceId !== aggregateCalId) return;
    var key = _buildKey(ev.start, ev.end, aggregateCalId);
    existingReverseKeys.set(key, ev);
  });

  /* Phase 1 — CLEANUP: delete stale reverse events */
  var deleted = 0;
  for (var entry of existingReverseKeys) {
    var key = entry[0];
    var ev = entry[1];
    if (!candidates.keys.has(key)) {
      _deleteEvent(targetCalId, ev.id);
      deleted++;
      _log(enableLogging, '   🗑️ Rev deleted: ' + ev.start + ' — ' + ev.end);
    }
  }

  /* Phase 2 — ADDITION: create missing reverse events */
  var created = 0;
  candidates.events.forEach(function(item) {
    if (existingReverseKeys.has(item.key)) return;

    _createEvent(
      targetCalId,
      'Busy',
      item.event.start,
      item.event.end,
      'Reverse-synced from aggregate',
      null,
      _buildExtProps('reverse', aggregateCalId),
      item.event.isAllDay,
      item.event._rawStart,
      item.event._rawEnd
    );
    created++;
    _log(enableLogging, '   ✅ Rev created: ' + item.event.start + ' — ' + item.event.end);
  });

  return { created: created, deleted: deleted };
}

/* ─────────────────────── ORCHESTRATOR ─────────────────────── */

/**
 * Master entry point — bind this to the time-driven trigger.
 * Runs reverse sync first (writes to sources), then forward sync
 * (reads from sources). This order ensures forward sync sees
 * reverse-synced events and can properly skip them.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.enableLogging=false]
 * @param {boolean} [opts.forceFullSync=false]
 */
function runAllSyncs(opts) {
  opts = opts || {};
  var enableLogging = opts.enableLogging === true;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    _log(true, '🔒 Another sync is running, skipping this execution');
    return;
  }

  try {
    _log(enableLogging, '═══ Calendar Sync v3.0 — ' + new Date().toISOString() + ' ═══');

    reverseSyncCalendars(opts);
    syncBusyCalendars(opts);

    _log(enableLogging, '\n═══ All syncs complete ═══');
  } finally {
    lock.releaseLock();
  }
}
