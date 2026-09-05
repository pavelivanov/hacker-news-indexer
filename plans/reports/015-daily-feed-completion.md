# Plan 015 — automatic updates and recovery

Date: 2026-09-05. Branch: `codex/013-local-manual-review-mvp`.
Builds on the local, uncommitted Plans 013/014. The owner authorized the A+B
milestone: automatic fresh results and operational visibility/recovery.

## Delivered behavior

The existing local supervisor starts a feed worker alongside the API and browser.
It reads the configured Telegram selection channel, resolves selected HN comments
and bounded root context, and stores classifier results for immediate private
browsing. Defaults are checks every 30 minutes, 20 selection IDs per batch, and
100 classifier requests per UTC day, including validation retries.

The results page has a compact status strip with Sync now, last check, processing
counts, daily usage, pause/resume, and failed-job retries. New arrivals offer
Show new results without replacing an open result or unsaved correction. Failed
predictions also offer Retry processing. Original predictions, source snapshots,
and correction history remain intact when a new attempt succeeds.

No human content verification or approval is required. Corrections remain
optional feedback, with no automatic training. Approved-reader/export controls,
historical evaluation evidence, and the configured model/prompt remain unchanged.
No hosted service was changed or deployed.

## Implementation and recovery

- Migration `0010_daily_feed` adds durable state/cursor, an isolated queue lane,
  UTC request reservations, retry receipts, and explicit classifier attempt
  identity. Historical jobs default to the legacy lane and existing runs to
  attempt 1. The migration was tested both cleanly and against older rows.
- Initial intake uses the newest 20 source IDs. Later batches continue after the
  saved cursor and cannot exceed the latest observed ID. Cursor advancement
  requires completed range ingestion; failed ingestion cannot skip a range.
- Feed jobs reuse the existing ingestion/resolution services. Classification
  waits for resolution, while terminal failures do not block unrelated comments.
  Legacy workers cannot claim feed jobs. One session advisory lock serializes
  the worker with the older local captured-comment generator.
- Bounded inputs are persisted before classifier dispatch. Restoring their
  builder field order after JSONB reads preserves the original input hash.
  This fixed an observed restart-replay bug that otherwise caused a redundant
  provider request. A persisted success is captured/reused after lost completion.
- Queue leases renew during work; renewal is drained before completion/requeue.
  Lease or session ownership loss stops further processing. Provider requests
  receive cancellation signals. The worker stops cleanly with the supervisor;
  uncompleted durable work remains recoverable.
- Atomic request reservation bounds concurrent dispatch. Daily exhaustion defers
  work without consuming its retry allowance, including a validation retry on
  the final job attempt. Transient failures get at most three job attempts.
  Authentication/configuration failures halt new dispatch; corrected settings
  take effect and clear the old error on restart.
- Retry commands have durable receipts and request hashes. Concurrent exact
  retries return one job; conflicting command-key reuse returns 409. Failed
  snapshots and owner feedback survive new classifier attempts.
- The classification core derives replayed decisions from the persisted winning
  response. A regression test exercises a competing response with a different
  category. This changes replay correctness, not classifier prompts or policy.
- Authenticated API endpoints expose bounded status/control/retry operations.
  Credentials stay server-side; Vite receives only its public local ports and
  process essentials. Test mode never starts the external-call worker.

Current mtcute documentation was fetched through Context7 for
`getHistory(sourceKey, { limit: 1 })`; the adapter test checks this bounded call.
No dependencies were added for this milestone.

## Verification

The full global gate passed and is recorded locally in
`/tmp/hn-feed-final-gate.log`. Its database commands use guarded npm aliases
targeting only `hn_manual_review_test`.

| Check | Result |
| --- | --- |
| Install, format, lint, typecheck, build | Passed |
| Unit tests | 294 passed across 40 files |
| Clean database validation/migration | Passed; 12 migrations |
| Integration tests | 86 passed across 14 files |
| Contract dry run | 4 passed; 4 unrelated/live cases skipped |
| Evaluation regressions | 42 passed plus existing fixture benchmark/shadow checks |
| Sealed-cycle validation | Passed; terminal outcomes unchanged |
| Web component tests | 10 passed |
| Real API/PostgreSQL browser journeys | 14 passed |
| Accessibility | 3 desktop/mobile/keyboard scenarios passed |
| Container build | Passed; image `d2ff73c7cedb` |

The 12 new integration cases cover incremental and bootstrap boundaries,
failed-ingestion recovery, pause/resume and queue isolation, concurrent request
reservations, validation-retry budget exhaustion on both initial and final job
attempts, immutable failed-result recovery with feedback, exact command replay,
lost completion without duplicate dispatch, authentication stopping new work,
exclusive worker ownership, persisted-response replay, and historical upgrade.

Browser tests exercise real pause/resume, arrival notification and list refresh,
duplicate prevention, and a retry whose response is dropped after the database
commit. Desktop and 390-pixel mobile checks report no serious/critical axe
violations or horizontal overflow. Synthetic recovery screenshots and the actual
live processing screen were visually inspected.

Host verification used supported Node 24.18.0; the container uses the repository's
24.19.0 pin. The pre-existing installation audit findings (one moderate and one
high) and PostgreSQL query-concurrency deprecation warnings remain unchanged.

## Local pilot

Preparation applied migration 0010 to the existing local database and replayed
the old capture idempotently, with zero HN fetches. Before starting live intake
there were 98 snapshots, zero corrections, and zero approval receipts. Their
immutable fields have digest
`86dc3f0ef4074f753a25c596d6b024fc11c8ea5999ef435a5edfe38ed6bffd7c`.
Live intake read the configured `hn_best_comments` source successfully and
selected Telegram IDs 33196–33215. All 20 HN comments resolved successfully.
Classification completed in 20 provider requests with zero failed jobs, producing
20 new results: 7 predicted Expert notes, 2 predicted Discoveries, and 11 skipped
comments. The total is now **118 results: 46 Expert notes, 13 Discoveries, and
59 skipped comments**, with no Uncertain/Failed rows. These are output counts,
not classifier-quality measurements.

The original 98 immutable snapshots retain the exact digest above. Feedback and
approval-receipt counts both remain zero. Clean shutdown reported the worker
offline; restart reported it online, preserved the completed batch/cursor and
118 results, and left request usage at 20. There were no duplicate dispatches
after restart. The next automatic check is scheduled for 18:14 UTC on 2026-09-05.
The API, browser server, worker, and PostgreSQL are left running for owner use at
`http://127.0.0.1:5173/?view=results`.

The Telegram client logged intermittent idle connection resets during the pilot;
they did not prevent intake or processing. Source availability remains an external
dependency, with connection failure and retry status surfaced in the browser.

The read-only browser smoke opened result/source/correction screens and the
processing details on desktop/mobile, submitted zero mutations, found zero
persistent browser storage entries, and verified that Lock clears the token.
It used the real local API and existing credentials without exposing them.
The final smoke retrieved all 118 results through pagination and opened all
three available result categories. Final formatting/lint and `git diff --check`
passed after adding the runbook and smoke updates. Sealed evaluation paths and
captured seed fixtures have no working-tree changes.

- [Actual processing screen](../../output/playwright/local-processing-desktop.png)
- [Actual mobile processing screen](../../output/playwright/local-processing-mobile.png)
- [Synthetic failed-job controls](../../output/playwright/processing-desktop.png)
- [Synthetic mobile recovery layout](../../output/playwright/processing-mobile.png)

## Practical limits

The worker runs on this computer while the workspace is running. It cannot
ingest during shutdown or sleep. First use intentionally skips older channel
history. A source-channel change requires an explicit cursor/data migration.
Limits are stored in the database; this milestone has no settings editor.

The request counter is conservative: a crash/cancellation after reservation may
consume allowance without a usable response. A crash after provider acceptance
but before local persistence can require a repeated provider request; exactly-once
provider billing is not guaranteed. The older explicit generator has a separate
invocation bound and does not consume the automatic feed's daily allowance.

Retries create additional results rather than collapsing all attempts into one
row. Feedback remains attached to its original result. A repeated failed-result
retry returns its existing recovery job; subsequent failures are retried from
Processing details. Global legacy-worker lifecycle repairs are not claimed here.

Search, bookmarks, feedback export, feedback-driven classifier improvements,
and hosted access remain later work. Browser verification covers Chromium.
Changes remain local and uncommitted; hosted CI has not run on this branch.

The [feed runbook](../../docs/daily-feed-local.md) covers startup, limits,
credentials, controls, failure recovery, API contracts, and test isolation.
