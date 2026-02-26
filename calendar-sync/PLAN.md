# Calendar Sync v3.0 — Full Upgrade Plan

## Context

You use a Google Apps Script to mirror "busy" blocks from 5 source calendars (personal gmail, 3 client emails, studio company) into an aggregate calendar, which then chains into a shared calendar for your business partner. The script runs every ~1 minute and works well (0.15% error rate), but you want:

1. Better event metadata (titles, colors, nicknames)
2. Smarter sync (incremental, 90-day window, cross-source dedup, filtering)
3. Reverse sync (manual blocks on aggregate → push to writable sources)
4. A simple booking page (visitors pick free slots)
5. Proper deployment pipeline (split files, clasp, GitHub Actions)

This plan was stress-tested by **two rounds of independent adversarial review** (69 issues found in Round 1, 16 new issues + corrections in Round 2) and **formally verified for loop-freedom** across 10 scenarios.

---

## Architecture Decisions (from review findings)

These are the key architectural choices driven by the review process:

### 1. Use `extendedProperties.private` for ALL event tagging (not description field)
**Why:** The description field is user-editable. If a user edits a synced event's description, it breaks tag detection and can cause phantom duplicates. Private extended properties are invisible in Calendar UI and tamper-proof.

**Schema:**
```
extendedProperties.private = {
  managedBy: "calendar-sync",    // present on ALL script-managed events
  sourceId:  "arpit@gmail.com",  // which source calendar
  type:      "forward" | "reverse" | "booked"
}
```

The `description` field is freed up for human-readable info (source nickname, booker details, etc.).

### 2. syncToken as change-detector ONLY
**Why:** The hybrid approach (use syncToken data for incremental reconcile) is fragile — iCalUID can't be combined with syncToken, the window drifts, and any change triggers full reconcile anyway. Instead:
- Call `events.list` with syncToken + `maxResults: 1`
- If 0 items → skip that source (nothing changed)
- If any items or 410 GONE → do a full time-windowed fetch
- This gives 90%+ of the performance benefit with zero complexity

### 3. iCalUID dedup uses composite key: `iCalUID + startTime`
**Why:** All instances of a recurring event share the same iCalUID. Using iCalUID alone would collapse a weekly standup into 1 event. The composite key correctly identifies unique instances while still deduping the same meeting seen from multiple source calendars.

### 4. Forward sync cleanup is scoped to only its own events
**Why:** Current code deletes ANY event on the aggregate whose key doesn't match a source. This destroys manual events, bookings, and reverse-synced origins. The formal verification proved this is the single blocker for all new features. Fix: cleanup only touches events with `extendedProperties.private.managedBy === "calendar-sync" && type === "forward"`.

### 5. Execution order: Reverse Sync → Forward Sync
**Why:** Reverse sync writes to source calendars. Forward sync needs to see those writes. Running reverse first ensures forward sync picks up the latest state. Sources that are also reverse-sync targets always do a full fetch (skip syncToken optimization).

### 6. Booking page requires Google Account sign-in
**Why:** Deploying as "Anyone" exposes ALL global functions via `google.script.run` — a visitor could call `purgeFutureEvents(true)` and wipe the calendar. Deploy as "Anyone with Google Account" and prefix all internal functions with underscore (Apps Script doesn't expose `_`-prefixed functions to `google.script.run`).

### 7. Title inclusion is per-source configurable
**Why:** Event titles can contain sensitive info ("Performance Review: John", "M&A Discussion"). Each source can opt into title exposure: `showTitle: true/false`.

---

## New CONFIG Schema

```javascript
const CONFIG = {
  lookAheadDays: 90,

  destinationCalendars: [
    {
      id: 'dest1-aggregate@group.calendar.google.com',
      label: 'Personal Aggregate',
      lookAheadDays: 90,
      sources: [
        {
          id: 'arpit.agarwal181@gmail.com',
          nickname: 'Personal',
          colorId: '9',              // Blueberry
          showTitle: true,           // show event titles (full access)
          excludeNotResponded: true  // skip needsAction events
        },
        {
          id: 'a.agarwal@roqit.com',
          nickname: 'Roqit',
          colorId: '6',              // Tangerine
          showTitle: false,          // busy-view only
          excludeNotResponded: false
        },
        {
          id: 'content.ai@klydo.in',
          nickname: 'Klydo',
          colorId: '3',              // Grape
          showTitle: false,
          excludeNotResponded: false
        },
        {
          id: 'arpit@studiotypo.xyz',
          nickname: 'Studio',
          colorId: '10',             // Basil
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
      id: 'dest2-shared@group.calendar.google.com',
      label: 'Shared Partner View',
      lookAheadDays: 90,
      sources: [
        {
          id: 'dest1-aggregate@group.calendar.google.com',
          nickname: 'My Calendar',
          colorId: '7',
          showTitle: false,          // privacy: partner doesn't see titles
          excludeNotResponded: false
        },
        {
          id: 'partner-aggregate@group.calendar.google.com',
          nickname: 'Partner',
          colorId: '2',
          showTitle: false,
          excludeNotResponded: false
        }
      ]
    }
  ],

  booking: {
    enabled: true,
    aggregateCalendarId: 'dest1-aggregate@group.calendar.google.com',
    pageTitle: 'Book a Meeting with Arpit',
    ownerTimezone: 'Asia/Kolkata',
    workingHours: { start: 9, end: 18, days: [1, 2, 3, 4, 5] },
    slotDurationMinutes: 30,
    lookAheadDays: 14
  }
};
```

---

## File Structure

```
toolbox/
  .github/
    workflows/
      deploy-calendar-sync.yml
  .gitignore                         # NEW
  calendar-sync/
    .clasp.json                      # script ID (safe to commit)
    .claspignore                     # whitelist only .gs, .html, .json
    appsscript.json                  # manifest: V8, Calendar API v3, scopes
    config.gs                        # CONFIG object
    sync.gs                          # syncBusyCalendars + forward sync
    reverse-sync.gs                  # reverseSyncCalendars
    booking.gs                       # doGet, getAvailableSlots, bookSlot
    booking.html                     # client-side booking page
    helpers.gs                       # shared utilities
  calendar-sync.gs                   # OLD — delete after migration verified
```

**File load order (alphabetical via clasp):**
`booking.gs → config.gs → helpers.gs → reverse-sync.gs → sync.gs`

This is safe because all files only define functions (no top-level imperative code). Function declarations are hoisted regardless of file order. `CONFIG` is a `const` but is available by the time any function actually executes (at trigger fire time, not file load time).

---

## Implementation Plan

### Phase 0: Safety Net (do FIRST, before any feature work)

**File: `sync.gs` — Fix the cleanup logic**

Scope the forward sync cleanup to only delete events it created:

```javascript
// BEFORE (current code, line 118-125 — deletes EVERYTHING)
destEvents.forEach(ev => {
  const key = _buildKey(ev.getStartTime(), ev.getEndTime(), ev.getDescription());
  if (!sourceKeys.has(key)) { ev.deleteEvent(); }
});

// AFTER (only delete forward-synced events)
destEvents.forEach(ev => {
  const props = ev.getTag('managedBy');  // extendedProperties approach
  if (props !== 'calendar-sync' || ev.getTag('type') !== 'forward') return;
  const key = _buildKey(...);
  if (!sourceKeys.has(key)) { ev.deleteEvent(); }
});
```

Also add skip rules to `_collectSourceEvents`: ignore events with `type === "reverse"` or `type === "booked"` on source calendars.

**This is the single most critical change. Without it, reverse sync and booking are provably broken.**

### Phase 1: Enable Advanced Calendar Service + Split Files

1. Create `calendar-sync/` folder with all files
2. Create `appsscript.json` with:
   - V8 runtime
   - Advanced Calendar Service (Calendar API v3)
   - Scopes: `auth/calendar` (read+write)
   - Timezone: `Asia/Kolkata` (match your operational timezone)
3. Split existing code into config.gs, sync.gs, helpers.gs
4. Replace `CalendarApp.getCalendarById().getEvents()` with `Calendar.Events.list()` calls
5. **IMPORTANT:** Always set `singleEvents: true` in API calls (otherwise recurring events won't be expanded — this was a CRITICAL review finding)
6. Handle all-day events: check `event.start.date` (string like "2026-02-26") vs `event.start.dateTime` (ISO datetime)
7. Handle busy-view calendars: `Calendar.Events.list()` may return 403 for free/busy-only calendars. Catch and fall back to `CalendarApp` for those specific sources.

**Key functions in `helpers.gs`:**
- `_fetchEvents(calendarId, winStart, winEnd)` — Advanced Calendar Service with CalendarApp fallback
- `_buildKey(start, end, marker)` — unchanged
- `_getWindowBounds(days)` — unchanged
- `_log(enabled, msg)` — unchanged
- `_buildEventTitle(event, sourceConfig)` — "Busy - {title}" or "Busy ({nickname})"
- `_shouldExclude(event, sourceConfig)` — filter needsAction via `attendees[].self === true` check
- `_deduplicateByICalUID(eventsBySource)` — composite key: `iCalUID + startTime`
- `_withRetry(fn, maxRetries)` — exponential backoff for 403/429 errors
- `_getEventTime(timeObj)` — parse both `dateTime` and `date` formats

### Phase 2: Incremental Sync (syncToken as change-detector)

1. Store syncTokens in `PropertiesService.getScriptProperties()` with key `syncToken_{calendarId}`
2. On each run, for each source:
   - Read stored token
   - Call `Calendar.Events.list(calId, { syncToken, maxResults: 1 })`
   - If 0 items returned → skip source, store new token
   - If any items or 410 error → do full time-windowed fetch, store new token from response
3. Sources that are also reverse-sync targets: always full fetch (skip optimization)
4. Periodic full re-sync: every 24 hours, clear all tokens and force full sync (catches drift)
5. Time guard: if `Date.now() - startTime > 300_000` (5 min), stop gracefully and let next trigger continue

### Phase 3: Event Metadata (titles, colors, nicknames)

1. Add `nickname`, `colorId`, `showTitle`, `excludeNotResponded` to CONFIG per source
2. Event title logic:
   - Source has real title AND `showTitle: true` → "Busy - {title}"
   - Source is busy-view OR `showTitle: false` → "Busy ({nickname})"
3. Color: set `colorId` on `Calendar.Events.insert()` call
4. Description: human-readable source info (freed from tagging duty)
5. Tags: `extendedProperties.private` for all machine-readable metadata

### Phase 4: Cross-Source Dedup (iCalUID)

1. After collecting events from all sources, group by `iCalUID + startTime` composite key
2. When same event appears from multiple sources, pick the best representative:
   - Prefer source with real title (not "Busy")
   - Then prefer source with `responseStatus === "accepted"`
   - Then prefer source with lower CONFIG index
3. Events without iCalUID: no dedup (fall through as separate events)

### Phase 5: Reverse Sync

**File: `reverse-sync.gs`**

1. `reverseSyncCalendars(opts)` — new entry point
2. For each destination with `reverseSync.enabled`:
   - Read aggregate calendar events in window
   - Filter to candidates: events WITHOUT `extendedProperties.private.managedBy === "calendar-sync"` (i.e., manually created by user) PLUS events with `type === "booked"` (from booking page)
   - For each writable target:
     - Delete stale reverse events (tagged `type: "reverse"`, key not in candidate set)
     - Create missing reverse events (tagged `type: "reverse"`, `sourceId: aggregateCalId`)
3. Master orchestrator function (bind to trigger):
   ```javascript
   function runAllSyncs(opts) {
     reverseSyncCalendars(opts);  // reverse first
     syncBusyCalendars(opts);     // then forward
   }
   ```

### Phase 6: Booking Page

**File: `booking.gs` (server-side)**

All internal functions prefixed with underscore. Only these are exposed to `google.script.run`:
- `doGet(e)` — serves booking.html via HtmlService
- `getAvailableSlots(timezone, startDate, endDate)` — calls `Calendar.Freebusy.query()`
- `bookSlot(slotStart, slotEnd, name, email, timezone)` — with LockService + re-check availability

Key details:
- Deploy as web app: "Execute as me" + "Anyone with Google Account"
- `bookSlot` creates event on aggregate with `extendedProperties.private.type = "booked"`
- Reverse sync picks it up next cycle and pushes to writable sources
- Working hours in owner's timezone (Asia/Kolkata), displayed in visitor's timezone
- Client-side auto-refresh every 5 minutes
- LockService serializes bookings to prevent double-booking

**File: `booking.html` (client-side)**

Simple vanilla HTML/CSS/JS:
- Timezone detection via `Intl.DateTimeFormat().resolvedOptions().timeZone`
- Date pills (horizontal scrollable days)
- Slot grid (time buttons for selected day)
- Booking form (name + email + confirm button)
- Loading, success, and error states
- Auto-refresh availability every 5 minutes

### Phase 7: Deployment Pipeline

**File: `.github/workflows/deploy-calendar-sync.yml`**

```yaml
on:
  push:
    branches: [master]
    paths: ['calendar-sync/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install -g @google/clasp@2.4.2  # pin version
      - name: Write clasp credentials
        run: |  # write ~/.clasprc.json from secrets
      - name: Push to Apps Script
        working-directory: calendar-sync        # CRITICAL: must cd here
        run: clasp push --force
      - name: Update deployment
        working-directory: calendar-sync
        run: clasp deploy -i ${{ secrets.CLASP_DEPLOYMENT_ID }}
```

**GitHub Secrets needed:**
- `CLASP_REFRESH_TOKEN` — from `~/.clasprc.json` after `clasp login`
- `CLASP_CLIENT_ID` — from `~/.clasprc.json`
- `CLASP_CLIENT_SECRET` — from `~/.clasprc.json`
- `CLASP_DEPLOYMENT_ID` — from `clasp deployments` (for web app URL stability)

**First-time setup checklist:**
1. `npm install -g @google/clasp`
2. Enable Apps Script API at https://script.google.com/home/usersettings
3. Get Script ID from Apps Script project settings
4. `clasp login` (creates `~/.clasprc.json`)
5. **CRITICAL:** Set GCP OAuth consent screen to "Production" (not "Testing") — otherwise refresh token expires in 7 days
6. Enable Google Calendar API in GCP console (APIs & Services → Library)
7. Extract secrets from `~/.clasprc.json` → GitHub repo secrets
8. Create `.clasp.json` in `calendar-sync/` with the script ID

**Other files:**
- `.gitignore`: `.clasprc.json`, `node_modules/`, `.DS_Store`, `Thumbs.db`
- `.claspignore`: whitelist `**/*.gs`, `**/*.html`, `appsscript.json`

### Phase 8: Migration & Purge

1. Deploy the new code via `clasp push`
2. Verify in Apps Script editor that all files appear
3. Run `purgeFutureEvents({ destIndex: 0, deleteFlag: true, clearTokens: true })` on Dest 1
4. Run `purgeFutureEvents({ destIndex: 1, deleteFlag: true, clearTokens: true })` on Dest 2
5. Run `runAllSyncs({ enableLogging: true })` manually — this does a full sync with new format
6. Verify events appear with correct titles, colors, and no duplicates
7. Update the time-driven trigger to call `runAllSyncs` instead of `syncBusyCalendars`
8. Delete old `calendar-sync.gs` from repo root

---

## Improved Purge Function

```javascript
function purgeFutureEvents(opts = {}) {
  // opts.destIndex (default 0), opts.deleteFlag (default false), opts.clearTokens (default false)
  // Reads calendar ID from CONFIG
  // Aware of event types: forward, reverse, booked — logs each type separately
  // Dry-run mode lists events without deleting
  // clearTokens resets syncTokens for that destination's sources
}
```

---

## Verification Plan

After each phase, verify:

1. **Phase 0**: Create a manual event on aggregate → run `syncBusyCalendars` → manual event survives
2. **Phase 1**: Run sync → check execution logs → events appear on aggregate with correct metadata
3. **Phase 2**: Run sync twice → second run should be significantly faster (check execution time in logs)
4. **Phase 3**: Check aggregate calendar in Google Calendar UI → events show nicknames, colors, titles
5. **Phase 4**: Same meeting on personal + studio → only ONE Busy block on aggregate (not two)
6. **Phase 5**: Create manual "Block" on aggregate → wait 1 min → check personal + studio calendars → "Busy" block appears. Delete from aggregate → wait 1 min → disappears from sources.
7. **Phase 6**: Open booking URL → see free slots → book a slot → check aggregate has event → wait 1 min → check personal + studio have matching Busy block
8. **Phase 7**: Push a small comment change to master → check GitHub Actions → verify Apps Script updated
9. **Phase 8**: Full end-to-end smoke test, check execution logs for errors over 24 hours

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| 6-minute execution limit with 90-day window | Time guard at 5 min, stop gracefully. syncToken skip reduces most runs to <10s. |
| Busy-view calendars return 403 from Advanced API | Per-source CalendarApp fallback for those specific calendars |
| OAuth token expires (GCP in Testing mode) | Setup checklist requires Production mode |
| clasp push pushes wrong files | `working-directory: calendar-sync` in every workflow step |
| User edits event description | Tags in extendedProperties (invisible, tamper-proof) |
| Booking page abuse | Google Account required, LockService serialization |
| Privacy: event titles leak | Per-source `showTitle` flag, default false |
| Concurrent trigger executions | LockService.tryLock with 5s timeout, skip if locked |
| PropertiesService 500KB limit | Only store syncTokens (~100 bytes each, ~1KB total) |
| Broken code deployed | Add ESLint syntax check step before clasp push |
