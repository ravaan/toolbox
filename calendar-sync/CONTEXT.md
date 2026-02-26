# Calendar Sync v3.0 — Project Context

## What This Is

A Google Apps Script that mirrors "busy" blocks from multiple source calendars
into aggregate destination calendars. Currently deployed as v2.4 (single file:
`calendar-sync.gs` in repo root). This folder (`calendar-sync/`) contains the
v3.0 upgrade — all code is written but NOT yet deployed.

## Current State (v2.4 — LIVE in production)

- **File:** `calendar-sync.gs` (repo root) — DO NOT DELETE until v3.0 is verified
- **Runs:** Every ~1 minute via time-driven trigger on `syncBusyCalendars()`
- **Error rate:** ~0.15% (mostly midnight rate limits)
- **Execution time:** 4-58 seconds per run

## What v3.0 Adds (this folder — NOT YET DEPLOYED)

All code is written and ready. Needs manual setup + testing before going live.

1. **Advanced Calendar Service** — uses Calendar API v3 instead of CalendarApp
2. **Incremental sync** — syncToken change detection, 90-day look-ahead window
3. **Event metadata** — per-source nicknames, colors, configurable title inclusion
4. **Cross-source dedup** — iCalUID + startTime composite key
5. **Per-source filtering** — configurable excludeNotResponded
6. **Reverse sync** — manual blocks on aggregate push to personal + studio calendars
7. **Booking page** — simple HtmlService page for external people to book meetings
8. **Scoped cleanup** — only deletes its own forward-synced events (tamper-proof via extendedProperties)
9. **clasp + GitHub Actions** — auto-deploy on push to master (currently disabled)

## Architecture (key decisions from adversarial review)

- **extendedProperties.private** for all event tagging (not description field)
- **syncToken as change-detector only** (not for data retrieval)
- **iCalUID + startTime** composite key for dedup (not iCalUID alone — recurring events share UIDs)
- **Cleanup scoped to type=forward** events only (manual/booked/reverse events are untouched)
- **Execution order: reverse sync → forward sync** (so forward sees reverse writes)
- **Booking page requires Google Account** (underscore-prefixed internal functions hidden from google.script.run)

## Source Calendars

| Email | Nickname | Access | Write? |
|-------|----------|--------|--------|
| arpit.agarwal181@gmail.com | Personal | Full | Yes |
| a.agarwal@roqit.com | Roqit | Busy-view | No |
| content.ai@klydo.in | Klydo | Busy-view | No |
| arpit@studiotypo.xyz | Studio | Full | Yes |

## Destination Calendars

| Calendar ID (first 8 chars) | Label | Sources |
|------------------------------|-------|---------|
| 7c2bef9a... | Personal Aggregate | All 4 sources above |
| 45b00590... | Shared Partner View | Personal Aggregate + Partner's aggregate |

## Files in This Folder

| File | Purpose | Lines |
|------|---------|-------|
| config.gs | CONFIG object — calendar IDs, nicknames, colors, booking settings | ~100 |
| helpers.gs | Shared utilities — fetching, dedup, filtering, retry, purge | ~400 |
| sync.gs | Forward sync — syncBusyCalendars, scoped cleanup, source collection | ~200 |
| reverse-sync.gs | Reverse sync + runAllSyncs orchestrator | ~180 |
| booking.gs | Booking page server-side — doGet, getAvailableSlots, bookSlot | ~250 |
| booking.html | Booking page client-side — date pills, slot grid, booking form | ~300 |
| appsscript.json | Apps Script manifest — V8, Calendar API v3, scopes | ~20 |
| .clasp.json | clasp config — needs YOUR Script ID | ~4 |
| .claspignore | File whitelist for clasp push | ~6 |

## What Was Reviewed

The plan was stress-tested by:
- **Round 1:** 3 independent adversarial agents found 69 issues (10 CRITICAL)
- **Round 2:** 2 agents found 16 more issues, corrected 4, identified 6 cross-plan conflicts
- **Formal verification:** Proved loop-freedom across 10 scenarios

All CRITICAL issues were addressed in the code. See PLAN.md for full details.
