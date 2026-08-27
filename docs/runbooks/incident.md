# Production incident and observability runbook

Protect credentials and retained content first, then restore a bounded safe
service. Logs and incident notes may contain IDs, states, durations, safe error
codes, deployment metadata, and hashes; they must not contain source bodies,
prompts, outbox payloads, tokens, session data, database URLs, or unredacted URL
query strings.

## Severity and first response

- **P1:** credential/content exposure, destructive data behavior, database
  corruption, or unsafe external mutation. Disable the affected path and page
  the owner immediately.
- **P2:** sustained API unavailability, worker crash loop, scheduler failure,
  queue stall, or restore/rollback failure. Stop new work and recover.
- **P3:** degraded latency, isolated retries, or review backlog without data
  risk. Investigate during the next operator window.

Record incident ID, UTC start, reporter, environment, deployment IDs, symptom,
and every mutation. Do not paste raw environment configuration.

Initial read-only checks:

```sh
railway status --json
railway deployment list --service api --environment production --limit 10 --json
railway logs --service api --environment production --lines 200 --json
railway logs --service worker --environment production --lines 200 --json
railway logs --service scheduler --environment production --lines 100 --json
```

Inspect Railway CPU, memory, restart, Postgres health/storage, and deployment
graphs for the same bounded time window.

## Signal and alert policy

Use sustained conditions so personal-scale traffic does not page on one retry.
These are initial staging thresholds and must be tuned after a soak:

| Signal                  | Initial alert                                                 |
| ----------------------- | ------------------------------------------------------------- |
| API `/healthz`          | 2 consecutive failures over 2 minutes                         |
| API `/readyz`           | unavailable for 2 minutes                                     |
| Worker heartbeat log    | no `worker_heartbeat` for 3 minutes                           |
| Worker crashes/restarts | 2 restarts in 10 minutes                                      |
| Pipeline failures       | 3 failures in 10 minutes or any new terminal-job count        |
| Queue age/depth         | oldest runnable job over 15 minutes with depth above 10       |
| Classification schema   | any invalid schema after live classifier approval             |
| Classification p95      | over 60 seconds for a sustained evaluation window             |
| Review backlog          | oldest open review over 7 days or unexpected rapid growth     |
| Feed diversity          | more than 2 same-root items in the first 20                   |
| Export                  | any failed acknowledgement/retraction or unreviewed insertion |
| PostgreSQL              | unhealthy/restarting, storage above 80%, or backup failure    |
| Service resources       | CPU/memory above 85% for 10 minutes                           |

The authenticated API `/metrics` currently exposes API-process metrics and a
database-backed review-queue measurement. Worker-local counters are not shared
with the API process; use structured worker logs and database queue checks until
a deployment-level collector is proven. Do not claim a dashboard covers worker
metrics merely because their metric names appear in API output.

### Repository-controlled signal check

Run the bounded, read-only application check from a trusted operator checkout:

```sh
npm run observability:check -- https://<api-domain>
```

The command reads `APP_API_TOKEN` from the gitignored `.env`, resolves the
explicit `OBSERVABILITY_ENVIRONMENT` (default `staging`), and collects:

- API liveness, readiness, protected review/feed metrics, and expected service
  deployment states;
- bounded worker/scheduler structured logs without returning their raw fields;
- Railway's bounded 15-minute raw CPU/memory metrics for the long-running API,
  worker, and PostgreSQL services plus aggregate volume usage/capacity;
- aggregate-only queue, lease, terminal-job, recent classifier, and recent
  export-failure counts through the private PostgreSQL service.

It never selects pipeline payloads, classifier output, source content, review
content, export payloads, environment values, or Telegram session data. Output
contains only project ID suffix, service states, bounded utilization
percentages, numeric aggregates, safe alert codes, and thresholds. Exit `0`
means no policy alert, exit `2` means alerts fired, and exit `1` means
collection/configuration failed closed.

CPU and memory alert only when at least ten paired usage/limit samples cover at
least nine minutes, the newest sample is no older than two minutes, and the
covered interval remains above 85%. Short, stale, or unpaired samples produce
no sustained-utilization claim. Volume usage is capacity-based rather than
burst-based and alerts above 80%. The daily scheduler is intentionally excluded
from sustained resource checks because it is ephemeral; service state and
completion freshness cover that role.

The command treats a last-served-page `feed_root_concentration` above `0.5` as
an advisory P3 signal. The exact “more than two same-root items in the first
20” release gate still belongs to `npm run feed:audit`; a small or empty page is
not enough evidence for that release decision.

Set `OBSERVABILITY_TERMINAL_BASELINE` to the acknowledged terminal-job count.
After the first scheduler completion is observed, set
`OBSERVABILITY_REQUIRE_SCHEDULER=true`; completion older than 26 hours then
alerts. Do not enable that gate before the first scheduled run and mistake a
not-yet-due cron for an outage.

Railway automatically injects project, environment, service, deployment,
replica, region, and Git commit variables. The logger maps present values to
safe base bindings on every API, worker, and scheduler event. A deployment of
the implementing commit is required before those additional bindings appear in
live logs.

The first read-only staging baseline at 2026-08-27 15:11 UTC passed: API,
worker, scheduler, and PostgreSQL were `SUCCESS`; health/readiness/metrics were
available; queue, lease, terminal, classification, export, review, and feed
alert values were zero; and no alert fired. Scheduler enforcement was correctly
disabled pending its first due run.

A follow-up at 15:20 UTC overlapped the automatic deployment of merged commit
`2dc3485`. The worker had started normally, but its first 60-second heartbeat
was indexed just after the bounded log query, producing a false
`worker_heartbeat_stale` P2. The policy now treats the most recent
`worker_started` event as liveness during the same three-minute heartbeat grace
window while still reporting three starts in ten minutes as a restart loop. A
read-only recheck at 15:23 UTC passed with seven bounded worker events and no
alerts.

The first repository-controlled resource baseline at 22:41 UTC passed. The
ten-minute utilization floors were at most 0.7% across API, worker, and
PostgreSQL. The Telegram-session volume was 1.7% full and PostgreSQL was 3.1%
full. Raw metric points, service IDs, mount paths, and capacity values were not
copied into the report.

### Railway native monitors and routing

Current Railway documentation exposes Pro-plan CPU, RAM, disk, and network
egress monitors through the Observability dashboard, with email/in-app
notifications and optional webhooks. It does not document monitor creation in
CLI or Infrastructure as Code. Configure these only after a fresh operator
approval and a destination decision:

- API, worker, and scheduler CPU/memory: 85% sustained for 10 minutes.
- PostgreSQL CPU/memory: 85% sustained for 10 minutes.
- PostgreSQL and Telegram volume usage: 80%.
- Deployment failed/crashed and volume/monitor events: owner email/in-app;
  optionally a separately approved webhook that filters environment and event
  type.

Status: **NOT CONFIGURED — thresholds are defined, but dashboard monitors,
notification routing, and webhooks require a live Railway mutation and owner
destination choice**.

## API or database readiness failure

1. Confirm `/healthz` versus `/readyz`; liveness success with readiness failure
   usually points to PostgreSQL connectivity/migrations.
2. Inspect API deploy logs and Postgres status without printing variables.
3. Stop scheduler and, if writes are unsafe, the worker. Keep the API available
   only if read behavior is safe.
4. If caused by code and schema-compatible, follow `rollback.md`.
5. If data integrity is uncertain, preserve the database and follow
   `backup-restore.md`; do not reset or reapply migrations manually.

## Queue stall, lease recovery, and poison jobs

Expired leases are recovered by normal claims. Restart only one worker and
observe the exact job IDs/states. A retryable job should move to `RETRYABLE`
with a future `available_at`; a non-retryable or exhausted job becomes
`TERMINAL` with a safe `last_error_code`.

For a poison job:

1. Stop the scheduler and worker.
2. Record the exact job ID, type, state, attempts, timestamps, and safe error
   code without selecting `payload`.
3. Preserve a database backup.
4. Prefer a code fix and normal retry. If continued claims are unsafe, request
   explicit approval to mark only that exact job `TERMINAL`; do not bulk-update
   jobs or delete audit history.
5. Restart one worker and verify queue age/depth recovers.

## Classifier provider outage or invalid schema

Live classifier activation is currently blocked by Plan 003R and the worker has
no promoted runtime classifier adapter. Keep classifier secrets unset and do
not enable it in production. After future promotion, a provider outage must
fail closed to review/retry, never activate model content or export it. Disable
new classification work, preserve existing decisions, rotate a compromised
provider token, and rerun evaluation gates before re-enabling.

## Telegram incident

Set `TELEGRAM_ENABLED=false`, stop worker replicas, and follow
`telegram-session.md`. Revoke a compromised authorization in Telegram's
official active-sessions UI before creating a replacement. Do not log in from a
Railway shell or attach the session volume to another service.

## Content deletion or HN tombstone

Preserve provenance and immutable audit history. For upstream deletion/change,
run one approved reconciliation schedule and verify the selected comment/HN
availability, materialized content status, review task, and any immutable
FindThatProject `RETRACT` revision. Never hard-delete an export revision or
rewrite earlier evidence. For a private-retention request beyond supported
tombstones, pause serving/export and develop a reviewed deletion migration with
a backup and legal/product decision record.

## Credential exposure

1. Disable the affected service/path and remove public access if necessary.
2. Rotate only the exposed credential, then dependent credentials if scope is
   uncertain: API token, export consumer token, classifier token, Telegram
   session/API credentials, or database credentials.
3. Keep API and export tokens distinct and sealed. Confirm variable scope by
   names only.
4. Search bounded logs and image history for the exact secret only in a private
   operator environment; never paste the search output.
5. Redeploy affected roles and invalidate old credentials before resuming.

## Synthetic staging checks

Before production, deliberately and reversibly test:

- API readiness failure by pointing only a disposable staging API at an
  unavailable database, then restoring the reference.
- One fixture retryable job and expired lease, confirming log/queue alerts.
- One fixture invalid classifier schema after a promoted adapter exists.
- An aged fixture review task, confirming backlog alerting.

Record which alert fired, timestamps, routing, recovery, and confirmation that
no sensitive payload appeared. The repository policy tests now cover readiness
loss, queue age/depth, expired leases, sustained retryable failures, classifier
schema/latency, aged review, export failure, and secret-safe output. Current
status: **POLICY TESTED LOCALLY; LIVE SYNTHETIC FAILURES AND ALERT DESTINATIONS
NOT TESTED OR CONFIGURED**.

## Closeout

Close only after service health, queue state, backup status, secret scope,
bounded logs, and required rollback/restore checks pass. Record root cause,
timeline, impact, recovery, follow-ups, and which runbook/check failed. A P1
requires an explicit owner decision before live integrations or export resume.
