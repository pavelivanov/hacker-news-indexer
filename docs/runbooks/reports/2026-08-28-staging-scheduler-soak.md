# Staging scheduler soak — 2026-08-28

## Result

**PASSED FOR THE EMPTY STAGING CORPUS.** Railway launched the first configured
daily reconciliation cycle, the scheduler acquired its transaction lock,
completed successfully, and emitted the expected bounded completion event.
The repository-side freshness gate then passed after a later scheduler
redeployment. Production remained empty and no Railway or database mutation was
performed during verification.

The live run scheduled zero jobs because staging still contains no selected
comments. Duplicate suppression with a non-empty corpus is proven by the real
PostgreSQL integration test, not by this empty live result. Repeat the live
idempotency observation after bounded source ingestion is separately approved.

## Scope and identity

- Soak ID: `staging-scheduler-20260828-01`.
- Environment: `staging`; production service count remained zero.
- Configured schedule: `17 3 * * *` UTC.
- Scheduled deployment: commit `2dc3485`, deployment suffix `d521`.
- Post-merge deployment: commit `2dda9b9`, deployment suffix `45f0`.
- Railway CLI: authenticated Homebrew fallback `5.28.0`, read-only operations
  only. The incomplete asdf `5.45.2` installation still requires repair before
  infrastructure mutation.

Full project, environment, service, deployment, instance, and volume IDs remain
outside Git.

## Scheduled-cycle evidence

- Expected start: 2026-08-28 03:17:00 UTC.
- Completion event: 2026-08-28 03:21:36 UTC.
- Observed platform launch-to-completion offset from the cron boundary: about 4
  minutes 36 seconds.
- Event: `reconciliation_schedule_completed`.
- Schedule key: `2026-08-28`.
- Transaction lock: acquired.
- Limit: 10,000; jobs scheduled: zero.
- The scheduler deployment remained `SUCCESS` and the ephemeral process exited
  as expected under restart policy `NEVER`.

The first filtered service-level query returned no event after commit `2dda9b9`
deployed because Railway scopes that form to the latest scheduler deployment.
An exact-deployment bounded query recovered the earlier completion. The checker
now selects at most 20 recent `SUCCESS` or `REMOVED` scheduler deployments in
the 27-hour freshness window and queries only the safe “Reconciliation
schedule” log filter from each.

## Freshness and health evidence

- At 2026-08-28 08:20:05 UTC, `OBSERVABILITY_REQUIRE_SCHEDULER=true` passed.
- The bounded report found one scheduler completion event and emitted no alert.
- API, worker, scheduler, and PostgreSQL were all `SUCCESS`.
- API health, readiness, and protected metrics passed.
- Queue, expired lease, terminal, classifier-schema, export, review, and feed
  alert aggregates remained zero.
- Ten-minute CPU/memory floors remained at or below 0.6%; Telegram-session and
  PostgreSQL volumes remained at 1.7% and 3.1%.

## Idempotency evidence

The scheduler repository obtains a transaction-scoped advisory lock and writes
jobs with idempotency key `reconcile-schedule:<schedule-key>:<comment-id>` using
duplicate-skipping insertion. On a local PostgreSQL database with one selected
comment, the integration test called the schedule twice with the same key and
observed:

- first call: lock acquired, one job scheduled;
- second call: lock acquired, zero jobs scheduled;
- final reconciliation-job count: one.

The targeted reconciliation integration suite passed all four tests on the
merged code. A fallback-CLI direct SSH aggregate probe returned no remote
stdout despite exit zero, so it was discarded and is not cited as evidence.

## Follow-ups

- Set `OBSERVABILITY_REQUIRE_SCHEDULER=true` in the trusted operator `.env` for
  this established staging environment. New environments must keep it false
  until their first expected completion.
- Repeat the same-key live scheduling observation after a bounded staging
  source corpus exists and remote execution is explicitly authorized.
- Repair or upgrade the asdf Railway CLI to `5.45.2+` before any configuration
  change or production work.
- Native monitor routing, live synthetic alert failures, HN/Telegram staging
  checks, and production promotion remain separately gated.

Soak status: **COMPLETE FOR THE EMPTY STAGING CORPUS — FIRST CRON AND FRESHNESS
GATE PASSED; NON-EMPTY LIVE IDEMPOTENCY REMAINS A FOLLOW-UP**.
