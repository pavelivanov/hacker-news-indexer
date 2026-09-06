# Plan 017 completion: browser feed settings

Date: 2026-09-06. Delivery branch: `codex/017-browser-feed-settings`.
Baseline: `acc5d03` from Plan 016; PR 30 remains a separate integration step.

## Result

The local workspace now exposes **Processing details → Feed settings** with
two editable controls: check interval (1–1,440 whole minutes) and daily classifier
request limit (1–1,000). Current settings stay unchanged until saved. Changes
persist in PostgreSQL and apply without restarting the worker. No new
dependencies were introduced.

A changed interval schedules the next automatic check from the save time;
changing only the cap preserves the schedule. An explicitly requested sync can
still run sooner. A source check that fails after a settings save cannot replace
the new schedule with its older retry schedule. Paused updates remain paused.

Every provider request, including a validation retry, reserves allowance against
the current cap under the settings row lock. Saving never resets usage. Lowering
the cap below existing usage blocks further reservations; requests already
reserved can finish. Increasing the cap releases jobs waiting on the daily
allowance, preserving unrelated retry delays. Budget deferral takes the same
lock so a concurrent increase cannot strand a job until midnight. The dialog
explains that the cap counts requests, resets at midnight UTC, and does not set
a dollar spending limit.

Migration 0012 adds an independent settings version with a zero default. The
authenticated `PUT /v1/processing/settings` endpoint validates strict bounded
input, checks the expected version, and stores a command receipt in the same
transaction. Exact retries return their original receipt without replaying an
older configuration. Stale edits and altered command reuse return 409.

The dialog preserves inputs during background polling, validates inline, and
freezes an interrupted save for an exact retry. Conflicting edits remain visible
until the user explicitly reloads current settings. After a successful save or
replay, it fetches the current configuration. Late status polling cannot regress
the displayed settings version. Cancel closes without saving new edits.

The [feed runbook](../../docs/daily-feed-local.md) documents behavior and recovery.
Settings do not create feedback, content approvals, bookmarks, or prediction
changes. Classifier accuracy evaluation, tuning, and training remain deferred.

## Verification

The Global verification gate passed: clean dependency installation, formatting,
typed lint, type checks, production build, unit tests, PostgreSQL startup,
readiness and migration, integration tests, test-container teardown, and
production container build. Database writes in automated tests used the guarded
`hn_manual_review_test` database on loopback port 55432.

| Check | Result |
|---|---|
| Unit | 298 passed |
| Integration | 103 passed |
| Local contracts | 5 passed; 4 external checks skipped by dry-run |
| Evaluation fixture regressions | 42 passed; no live quality evaluation |
| Sealed-cycle validation | Three historical cycles remain valid |
| Web components | 10 passed |
| Browser | 22 journeys passed |
| Accessibility | 5 journeys passed; no serious/critical Axe violations |
| Clean migration | All 14 migrations applied successfully |
| Existing-data upgrade | Non-default settings, usage, and receipts preserved |
| Container | Built `hn-knowledge:verify` successfully |

New coverage includes input bounds/authentication, scheduling and pause state,
concurrent edits and exact retries, cap lowering during a validation retry,
budget release and both deferral race orders, and settings saved during a failed
source check. Browser tests exercise a real polling interval while editing,
save/reload persistence, validation/cancel, a committed write with its response
dropped, and two-tab conflicts. Desktop/mobile checks include keyboard focus,
Escape restoration, reduced motion, and invalid-field accessibility.

Initial integration runs exposed intermittent premature completion in the
existing fixture's queue-draining helper. It now waits for three brief
consecutive idle polls instead of treating one idle poll as completion. The final
103-test integration run passed with that helper and the scheduling regression.

## Local upgrade and visual inspection

Read-only snapshots before and immediately after migration matched exactly:
135 results, zero feedback records, zero approvals, 30-minute checks, a
100-request daily cap, batch size 20, enabled updates, and cursor 33232.
The original 98 prediction snapshots retained their SHA-256 fingerprint:

`86dc3f0ef4074f753a25c596d6b024fc11c8ea5999ef435a5edfe38ed6bffd7c`

Preparation replayed existing captures with zero HN fetches. After restarting
the already-enabled workspace, normal intake added one result. The subsequent
status check showed 136 results, 15 requests used that UTC day, no pending or
failed jobs, settings version 0, and the same original fingerprint. Feedback,
approvals, and bookmarks remained untouched. Live counts can grow normally.

The read-only browser smoke opened the settings dialog and three result
categories, checked search/saved views and lock behavior, and made zero
mutations. The actual dialog screenshots at 1440px and 390px were visually
inspected: `output/playwright/local-feed-settings-desktop.png` and
`output/playwright/local-feed-settings-mobile.png`. Both show current values,
usage, clear labels, and accessible actions without horizontal overflow.

The workspace is available at `http://127.0.0.1:5173/?view=results` while its local
supervisor is running. Startup persistence, backups, broader hosting, and merging
PR 30 are outside this selected item. The unrelated `.zcode/` remains untouched.
