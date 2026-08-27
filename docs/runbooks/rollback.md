# Railway rollback runbook

This procedure rolls application code back while preserving forward-only
database history. It is not permission to undo a Prisma migration or replace a
database/volume.

## Before every deployment

Record the environment, commit SHA, API/worker/scheduler deployment IDs, latest
successful database backup time, and migration list. Confirm the candidate
migrations use expand/contract discipline: old and new code must both work
between the expand and later contract releases.

Keep at least one known-good deployment visible in Railway's deployment
history. A release that removes or renames schema must not be deployed until the
old code no longer needs that schema and the rollback window is closed.

## When to roll back

Roll back for sustained readiness failure, crash loops, unsafe queue behavior,
secret/content leakage, material contract regression, or a failed bounded
post-deploy check. For database corruption or credential compromise, follow
`backup-restore.md` or `incident.md` first.

## Application rollback

1. Declare the incident and stop scheduler-triggered work.
2. If jobs may be unsafe under either version, scale or stop the worker before
   changing the API. Do not delete jobs or leases.
3. Inspect the last 200 lines of logs and list deployment IDs:

   ```sh
   railway deployment list --service api --environment staging --limit 10 --json
   railway deployment list --service worker --environment staging --limit 10 --json
   railway deployment list --service scheduler --environment staging --limit 10 --json
   ```

4. Verify the chosen known-good deployment predates the fault and is compatible
   with every migration already applied.
5. Roll back to the exact known-good deployment for `api`. The CLI's
   `redeploy` command still targets only the latest deployment, but Railway's
   public GraphQL API exposes `deploymentRollback(id: String!): Boolean!`.
   Verify the live schema first, then use the retained deployment ID:

   ```sh
   railway api describe deploymentRollback
   railway api \
     'mutation Rollback($id: String!) { deploymentRollback(id: $id) }' \
     --raw-var id=<known-good-deployment-id> \
     --compact
   ```

   A successful rollback restores the retained Docker image and its custom
   variables without a rebuild. Keep the pre-drill current deployment ID: after
   verification, invoke the same mutation with that ID to roll forward.

6. Verify `/healthz`, `/readyz`, authentication, and the expected commit/deploy
   metadata. A rollback is not complete merely because the mutation returned
   `true`; wait for the new deployment to reach `SUCCESS` and run the
   authenticated staging smoke.
7. Resume one worker, verify lease recovery and a bounded safe job, then resume
   the scheduler.

If the dashboard cannot redeploy the exact old artifact, pin the repository
source to the known-good commit in generated IaC, run `railway config plan`, get
approval, and apply/deploy that plan. Do not improvise an unreviewed local
upload during an incident.

## Database compatibility

Prisma migrations are forward-only in this project. Never run reverse SQL in
production. A code rollback is allowed only when the old code is compatible
with the current schema.

If it is not compatible:

1. Keep traffic/workers paused.
2. Preserve the affected database and logs.
3. Restore the latest acceptable backup into a disposable staging database.
4. Develop and verify a forward repair migration or roll-forward code fix.
5. Obtain explicit approval before touching production data.

## Verification

After rollback, confirm:

- API liveness/readiness and authenticated metrics.
- `worker_started`, recurring `worker_heartbeat`, and no transition failures.
- No unexpected `TERMINAL` jobs and no growing expired leases.
- Scheduler idempotency for the current UTC date.
- Nine or more expected migrations remain applied exactly once.
- Telegram session file still exists on the worker volume without re-login.
- No secret, source body, prompt, or payload appears in bounded logs.

## Drill record

Do not call rollback tested until a staging drill records all of these fields:

- Date, operator, environment, and incident/drill ID.
- From/to commit and deployment IDs (redacted suffixes in Git).
- Schema compatibility decision.
- Time rollback started, API recovered, worker resumed, and drill ended.
- Health, queue, scheduler, and session-persistence results.
- Observed RTO and follow-up actions.

## Staging drill — 2026-08-27

The live API deployment history and Git compatibility check selected this
bounded API-only rollback pair:

- Current deployment: ID suffix `83b7`, commit `98b9507`, `SUCCESS`, live
  `canRollback=true`.
- Known-good target: ID suffix `fd3d`, commit `12d169e`, retained in deployment
  history with inactive status `REMOVED` and live `canRollback=true`. This was
  the API-token redeployment that passed the original authenticated smoke before
  sealing.
- `12d169e..98b9507` changes only documentation, plans, the staging-smoke
  script/test, and the root `staging:smoke` package script. There are no changes
  under `apps/`, `packages/`, migrations, the Dockerfile, package lock, or
  Railway IaC, so both images are compatible with the same nine-migration
  database.
- The 2026-08-27 logical restore drill passed and its encrypted artifact remains
  available. Production is empty.
- Railway CLI `5.45.2` live schema confirms
  `deploymentRollback(id: String!): Boolean!`; current public documentation
  confirms rollback restores a retained image and custom variables without a
  rebuild. A read-only eligibility query confirmed both exact deployment IDs can
  be rollback targets.

The approved drill captured the current and target full IDs outside Git, ran a
pre-smoke, rolled back only `api`, waited for `SUCCESS`, ran smoke and bounded
logs, rolled forward to the captured current deployment, and repeated the
checks. Worker/scheduler/database configuration did not change.

The separate worker-volume persistence drill wrote one non-secret marker to
`/data/telegram`, restarted only the worker, verified the marker hash after the
new process started and emitted a heartbeat, then deleted the marker. It did not
create or inspect a Telegram session while Telegram was disabled.

The dated
[staging rollback report](reports/2026-08-27-staging-rollback.md) records exact
suffixes, timings, smoke and migration evidence, queue state, volume persistence,
cleanup, deviations, and follow-ups.

Current status: **TESTED IN STAGING — API ROLLBACK, ROLL-FORWARD, AND WORKER
VOLUME PERSISTENCE PASSED**.
