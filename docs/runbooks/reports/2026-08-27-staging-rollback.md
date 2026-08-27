# Staging application rollback drill — 2026-08-27

## Result

**PASSED.** The staging API rolled back to an exact retained known-good image,
passed authenticated smoke checks, and rolled forward to the captured current
image without a rebuild or schema change. A separate worker restart preserved a
non-secret marker on the attached Telegram volume, and the marker was removed
after verification. Production remained empty.

The drill proves application-image rollback and attached-volume persistence for
the current empty staging workload. It does not prove Telegram authorization
survives a restart because Telegram remained disabled and no session file was
opened or inspected.

## Scope and identity

- Drill ID: `staging-rollback-20260827-01`.
- Operator: repository owner with Codex execution and explicit approval.
- Railway CLI: `5.45.2`.
- Environment: `staging`; production service count remained zero.
- API from: commit `98b9507`, original deployment suffix `83b7`.
- API target: commit `12d169e`, retained deployment suffix `fd3d`.
- Rollback-created deployment suffix: `8eba`.
- Roll-forward-created deployment suffix: `b069`.
- Worker deployment suffix: `2bdd`; the restart reused the same deployment
  image and replaced the worker process identity.

Full project, environment, service, deployment, instance, and volume IDs remain
outside Git.

## Compatibility decision

Rollback was safe with the already-applied database history:

- `12d169e..98b9507` contains no changes under `apps/`, `packages/`, Prisma
  migrations, the Dockerfile, package lock, or Railway IaC.
- Both API candidates use the same start command, health check, and single
  pre-deploy migration command.
- Both exact retained deployment IDs reported `canRollback=true` immediately
  before the mutation.
- The active database retained nine applied migrations. Both rollback and
  roll-forward pre-deploy checks reported nine migrations and no pending
  migrations.

## API rollback evidence

- The pre-drill authenticated smoke passed for liveness, readiness, fail-closed
  metrics/feed authorization, authenticated metrics, and metrics content
  safety.
- Rollback mutation accepted: 2026-08-27 14:38:25 UTC.
- Rollback deployment reached `SUCCESS`: 2026-08-27 14:38:46 UTC.
- Observed platform rollback recovery time: about 20 seconds.
- The rollback deployment used commit `12d169e`, image digest matching the
  retained target, and Railway reason `rollback`.
- Post-rollback authenticated smoke passed all five checks.
- Bounded logs showed API startup, redacted configuration, nine migrations, and
  no pending migration or runtime failure.

## API roll-forward evidence

- Roll-forward mutation targeted the captured pre-drill deployment suffix
  `83b7`.
- Roll-forward mutation accepted: 2026-08-27 14:39:19 UTC.
- Roll-forward deployment reached `SUCCESS`: 2026-08-27 14:39:43 UTC.
- Observed platform roll-forward recovery time: about 24 seconds.
- The new active deployment uses commit `98b9507` and the original image digest.
- Post-roll-forward and final authenticated smokes passed all five checks.
- Final bounded API logs again showed nine migrations, none pending, and normal
  startup with sensitive configuration redacted.

## Worker-volume persistence evidence

- The marker contained no credentials or user data, had mode `0600`, and was
  written only to `/data/telegram`.
- Pre-restart marker SHA-256:
  `54c36c6a7d0feb54bad4fae289235d0f795e0139732060ac58878800d9218744`.
- The exact staging worker was restarted without a rebuild. Logs recorded a
  clean `SIGTERM`, volume mount, and a new `worker_started` process identity at
  2026-08-27 14:41:17 UTC.
- The post-restart marker mode, size, and SHA-256 matched exactly.
- The new worker emitted `worker_heartbeat` at 2026-08-27 14:42:17 UTC with
  zero active jobs.
- The marker was deleted and a separate readback confirmed it was absent. It is
  intentionally not recoverable and contained no sensitive material.

## Queue, scheduler, and final state

- A read-only database query returned zero pipeline jobs and zero expired
  leases. No queue record was mutated by the drill.
- The scheduler was not restarted or invoked. Its first configured cron run
  remains due at 2026-08-28 03:17 UTC, so scheduler idempotency remains part of
  the staging soak rather than this drill.
- Final API, worker, scheduler, and PostgreSQL statuses were `SUCCESS` and not
  stopped. Final worker error-level logs were empty.
- Final verification ended at 2026-08-27 14:44:41 UTC.
- The PostgreSQL and Telegram volumes remained attached and ready. The prior
  restore drill's scratch volume remains unattached in Railway's
  pending-deletion window.

## Deviations and follow-ups

- Railway's current live schema returns `Boolean!` from
  `deploymentRollback`, while one public API example still shows an object.
  The drill followed the live schema and verified the created deployments with
  separate readbacks.
- Two exploratory read-only GraphQL instance queries used unsupported nested
  fields and returned validation errors. The corrected query reported the
  worker deployment `SUCCESS`, not stopped, with a running instance. No mutation
  was coupled to the failed queries.
- A filtered structured-log lookup returned no heartbeat; a bounded unfiltered
  lookup showed the expected post-restart heartbeat.
- Prisma configuration messages and npm update notices are emitted on stderr
  and therefore labeled `error` by Railway even though migration and startup
  succeeded. Alerting should distinguish these from real failures.
- `railway service status --all` now warns that it is deprecated; use
  `railway service list` for future final snapshots.
- Complete the scheduler soak after its first cron run. Repeat restore and
  rollback drills after staging contains representative non-empty data, and
  verify the actual Telegram session only after Telegram activation is
  separately authorized.

Drill status: **COMPLETE — APPLICATION ROLLBACK, ROLL-FORWARD, AND WORKER VOLUME
PERSISTENCE PASSED**.
