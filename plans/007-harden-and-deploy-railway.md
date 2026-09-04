# Plan 007: Harden and deploy the API, worker, and PostgreSQL on Railway

> **Executor instructions**: Complete Plans 005 and 006 first. Remote Railway creation/configuration/deployment changes require explicit operator authorization at execution time. Always preview Infrastructure as Code changes and verify service IDs/environment before applying.
>
> **Drift check (run first)**: verify Plans 001–006 are `DONE`, all global/evaluation/export gates pass, and the production Docker image starts both API and worker roles locally. Re-check current Railway docs because platform configuration is time-sensitive.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/005-implement-knowledge-feed.md`, `plans/006-implement-findthatproject-export.md`
- **Category**: deployment / security / operations
- **Planned at**: unborn repository with no `HEAD`, 2026-08-24

## Why this matters

This plan creates a repeatable staging-to-production release with isolated services, single-path migrations, a sealed serialized Telegram session, health checks, backups, observability, and rollback/runbooks. Railway state must be explicit and reviewed rather than assembled ad hoc.

## Current state expected from dependencies

- One multi-stage Docker image supports API and worker commands.
- PostgreSQL migrations 0001–0006, API/readiness, queue workers, scheduler command, metrics, reconciliation, evaluation, and export exist.
- No Railway project/state is assumed.
- Current Railway guidance uses `.railway/railway.ts` Infrastructure as Code. `railway.json`/`railway.toml` Config as Code is deprecated for new services and has a 2026-12-01 cutoff.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Local release | `npm ci && npm run release:verify` | all gates and image smoke tests pass |
| Railway auth/context | `railway whoami --json` and `railway status --json` | correct account/project/environment |
| Initialize IaC | `railway config init` | creates `.railway/railway.ts` using current DSL |
| Preview IaC | `railway config plan` | expected services/variables/volume only; no deletes |
| Apply IaC | `railway config apply` | only after operator approval; exit 0 |
| Deploy service | `railway up --service <name> --environment <env> --detach -m "<summary>"` | deployment created |
| Verify | `railway service list --environment <env> --json` and bounded `railway logs` | all expected services healthy |

## Suggested executor toolkit

- Use the Railway skill/current official documentation and CLI 5.43.1 or newer.
- Current sources: [Railway CLI/IaC](https://docs.railway.com/cli), [Dockerfiles](https://docs.railway.com/builds/dockerfiles), [pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command), [variables](https://docs.railway.com/variables), and [healthchecks](https://docs.railway.com/deployments/healthchecks).
- Pre-deploy commands run in a separate container without mounted volumes; use them only for Prisma migrations, never Telegram session initialization.

## Scope

**In scope**:

- Production Docker/Docker Compose refinements.
- `.railway/railway.ts` generated with current CLI and its project graph.
- `docs/runbooks/{deploy,rollback,telegram-session,backup-restore,incident}.md`.
- Release verification/smoke/load scripts and CI release workflow.
- Railway staging and production environments, PostgreSQL, API, worker, scheduler/cron, variables, health checks, restart/drain policy, logs/metrics/backups, and retirement of the legacy worker volume after verification.
- Security, recovery, and performance validation.

**Out of scope**:

- Multi-region, more than one worker replica, Redis, Kubernetes, public multi-user auth.
- Frontend deployment.
- Direct downstream FindThatProject mutation.
- Applying/deleting Railway resources without operator approval.
- Putting Telegram session bootstrap or interactive login in pre-deploy/runtime commands.

## Git workflow

- Branch: `codex/007-railway-production`.
- Commit Docker/release checks, IaC/runbooks, and production observations separately.
- Never commit `.railway` local state containing IDs/secrets if the generated format marks it local-only; commit only the declarative file/current supported lock metadata.
- Do not push or deploy production unless instructed.

## Steps

### Step 1: Create a release-verification command and harden the image

`npm run release:verify` must run clean install, Prisma validate/generate, format/lint/typecheck/build, unit/integration/evaluation/export tests, clean migration replay, seed replay, Docker build, API health/readiness smoke, worker lease/restart smoke, and secret-log scan.

The final image must pin Node `24.19.0` at planning time, run non-root, contain production dependencies/generated Prisma client/migrations, honor SIGTERM, have no `.env`/fixtures/dev credentials, and support explicit commands `npm run start:api`, `npm run start:worker`, and `npm run schedule:once`.

**Verify**: `npm run release:verify` exits 0 twice from a clean checkout/worktree and `docker history`/image inspection shows no secret files.

### Step 2: Define the Railway resource graph with current Infrastructure as Code

Authenticate and resolve context. If no project exists, request operator authorization before creating one. Run `railway config init` to generate `.railway/railway.ts`; do not hand-copy the deprecated `railway.json` shape.

Define staging and production with:

- managed PostgreSQL service, private only;
- API service from the root Dockerfile, start command API, public domain, `/healthz` deployment healthcheck, restart-on-failure, graceful drain;
- worker service from the same Dockerfile, worker start command, no public domain, one replica, and no filesystem dependency for its sealed serialized Telegram session;
- scheduler/cron service from the same image, `schedule:once`, no public domain, a conservative daily reconciliation schedule initially;
- full repository build context because npm workspaces import shared packages;
- watch paths so docs/frontend-only changes do not redeploy every backend service unnecessarily.

Only the API service has pre-deploy command `npm run db:migrate:deploy`. Worker/scheduler must not run migrations, preventing races.

**Execution note (2026-08-27):** Railway CLI `5.45.0` correctly targets the
linked environment for the plan but invokes the TypeScript program with an
empty `ctx` object. An environment-derived domain therefore rendered the
production name in a staging plan. Keep the IaC graph environment-independent
and generate the single API Railway domain with `railway domain` after each
approved environment apply until the documented context behavior is fixed and
re-verified.

**Follow-up (2026-08-31):** Railway CLI `5.45.10` now supplies
`ctx.environment` correctly. A production plan using an environment-conditional
legacy volume produced four creates (PostgreSQL, API, worker, scheduler), zero
updates, and zero destroys; it did not create or mount the staging-only
Telegram volume. Re-targeting the same file to staging retained that volume,
confirming the context fix. The staging plan also exposed destructive drift for
sealed variables managed outside IaC, so it was not applied. Continue to plan
each environment separately and never apply a staging plan that removes those
variables.

**Verify**: `railway config plan` shows only the intended creates/updates, no deletion/replacement of an existing database/volume, one migration path, and correct start commands. Save a redacted plan summary in the deploy runbook.

### Step 3: Configure variables and secret boundaries

Use Railway reference variables for PostgreSQL `DATABASE_URL`. Set/seal independently scoped secrets:

- API: `APP_API_TOKEN`, `EXPORT_CONSUMER_TOKEN` if export endpoint is enabled;
- worker: classifier provider credentials plus Telegram API ID/hash, source key, and serialized session only when enabled;
- scheduler: database URL and schedule configuration only.

Do not give Telegram or classifier secrets to the API/scheduler. Do not pass secrets as Docker build args. Mark production secrets sealed through the Railway UI when appropriate.

For Telegram, accept native mtcute, GramJS, Telethon v1, or Pyrogram serialized
sessions through the worker-only `TELEGRAM_SESSION` secret, using mtcute's
official converters for external formats. Import the result into in-memory
storage and verify authorization headlessly before processing jobs. Never
print, commit, pass in command-line arguments, or place the string in IaC. Seal
it through the Railway dashboard and define rotation/revocation in the runbook.
A serialized session still represents the Telegram identity that created it;
it removes deployment login and file transfer, not the underlying authorization.

**Verify**: `railway variable list --service <service> --json` confirms key presence/scope without outputting values; API and scheduler lack Telegram/classifier keys; one worker imports the sealed session after a restart without filesystem state or interactive login.

### Step 4: Deploy staging in safe modes

Apply IaC only after explicit approval. Deploy PostgreSQL/API/worker/scheduler to staging with classifier fixture/shadow mode, export disabled, and Telegram live ingestion disabled initially. Confirm migration, `/healthz`, `/readyz`, auth, worker heartbeat/lease recovery, scheduler idempotency, and bounded logs.

**Execution note (2026-08-27):** The operator approved and applied the reviewed
staging graph: five creates, zero updates, zero destroys. PostgreSQL, API,
worker, and scheduler deployments reached `SUCCESS`; both volumes reached
`READY`; all nine migrations applied through the API pre-deploy command; and
Railway's `/healthz` deployment check passed. Railway injected `PORT=8080`, so
the deferred API domain must target port `8080`, not the earlier local default
of `3000`. No domain, application secret, live integration, production
resource, or manual scheduler run was authorized or created.

**Follow-up (2026-08-27):** The operator separately authorized
`APP_API_TOKEN`, one staging API domain, and read-only smoke checks. The token
was streamed through stdin to the API only; deployment suffix `fd3d` reached
`SUCCESS`. Exactly one service domain became `ACTIVE` on port `8080`, all other
roles remained private, and the bounded liveness/readiness/fail-closed
auth/authenticated-metrics smoke passed without printing response bodies or
secrets. Railway CLI `5.45.1` returned a generic create error despite creating
the domain, so the runbook now requires readback before retrying.
The CLI has no command for sealing an existing variable, and an attempted
`isSealed` configuration patch was a no-op. Current Railway documentation
requires the variable's dashboard three-dot menu. The operator completed that
irreversible seal: API configuration retained the key, CLI variable readback
omitted its value, and the post-seal authenticated smoke still passed.

After PR 11 merged as commit `98b9507`, Railway automatically deployed that
commit to the staging API, worker, and scheduler. All four services remained
`SUCCESS`, the worker emitted its first `worker_heartbeat` at 13:42 UTC, and
the authenticated staging smoke passed against the new API deployment. The
first scheduler cron completed at 03:21 UTC on 2026-08-28 with its daily key,
lock acquired, and zero jobs for the empty staging corpus. A same-key local
PostgreSQL integration test with one seeded comment scheduled one job on the
first call and zero on the second. The scheduler-required live check passed
after a later redeploy by querying bounded logs across recent deployments.

The initial staging graph included a worker-mounted Telegram-session volume.
Before live integration, the operator replaced that design with a sealed
`TELEGRAM_SESSION` string imported into memory. Keep the unused legacy volume
attached until the new path passes local contract, staging restart, and bounded
ingestion checks; its removal is a separate destructive change.

The supplied GramJS string then passed mtcute's official conversion, headless
authorization, and the bounded exact 100-ID Telegram contract at 10:31 UTC on
2026-08-28. The commands emitted no identity, credential, or source body.

After merge commit `c2b672a` deployed, the operator confirmed the session and
API hash sealed on the staging worker. Runtime headless authorization passed,
Telegram-enabled deployment `b60867c9-82b9-4343-90dc-1b6809fdefa1` reached
`SUCCESS`, and approved run `f2551955-5deb-4b4e-9ec1-d8bc68d14d5a` processed
the exact 100-ID range. It observed 100 occurrences, resolved 98 HN comments,
retained zero Telegram bodies, and made no retries. Its only terminal jobs were
the expected 98 `CLASSIFIER_DISABLED` results. Authenticated API smoke and
restart deployment `a30528d4-b575-4f7a-990e-b8e09a5d035b` also passed without
warning/error events or runtime login. The legacy volume remained untouched;
its removal is still a separate destructive change.

Then enable one external dependency at a time: HN live contract, Telegram bounded read, classifier shadow, and finally reviewed local publication. Never enable automatic export during staging rollout.

**Verify**: service status healthy; bounded build/runtime logs show expected version/role and no secrets/source bodies; one bounded seed ingestion completes with exact counts and evaluation gates.

### Step 5: Establish backup, restore, rollback, and incident runbooks

Document and test:

- Railway PostgreSQL backup/PITR settings available to the plan;
- an encrypted logical backup procedure and retention location controlled by the owner;
- restore into a disposable staging database and integrity checks for key table counts/FKs;
- image/deployment rollback;
- expand/contract migration discipline because Prisma migrations are forward-only;
- Telegram serialized-session revocation/rotation;
- classifier credential rotation and provider outage/shadow disable;
- job queue pause, lease recovery, poison-job quarantine;
- content deletion/tombstone incident response.

Do not claim recovery works without a restore drill.

**Recovery preflight (2026-08-27):** Railway CLI `5.45.1` reports PITR disabled
and no backup bucket wired for staging PostgreSQL. Both the configured schedule
list and on-demand backup list are empty. This was a read-only inspection; no
backup, schedule, sibling restore service, or database mutation was created.
The next recovery action requires explicit operator approval.

The operator then approved the lower-cost logical path without PITR. A
PostgreSQL 18 dump was streamed directly through `age`, its 303-entry archive
catalog was verified, and it restored in six seconds into a private scratch
PostgreSQL 18 service. Source/restored counts, nine migrations, and foreign-key
state matched; private API liveness/readiness/fail-closed auth/authenticated read
checks passed; bounded logs were clean; and end-to-end verification took 13
minutes 6 seconds. The scratch services were removed and their unattached
volume entered Railway's pending-deletion window. The dated report records the
CLI deviations and the remaining offline-key/non-empty-data follow-ups.

**Rollback preflight (2026-08-27):** Current deployment suffix `83b7` at commit
`98b9507` and retained known-good suffix `fd3d` at commit `12d169e` have no
application, migration, Dockerfile, lockfile, or IaC differences. Railway CLI
`5.45.2` live schema exposes `deploymentRollback(id: String!): Boolean!`, and
current documentation states that it restores the retained image and custom
variables without rebuilding. A read-only query confirmed both the current and
inactive known-good deployments have `canRollback=true`. The runbook now
defines an exact-ID rollback, authenticated smoke, exact-ID roll-forward, and
separate worker-volume marker restart drill. No rollback or restart mutation
was executed without fresh operator authorization.

**Rollback execution (2026-08-27):** After explicit approval, the staging API
rolled back to commit `12d169e` in about 20 seconds and rolled forward to commit
`98b9507` in about 24 seconds. Pre-rollback, post-rollback, post-forward, and
final authenticated smoke checks passed; both deployment starts found the same
nine migrations with none pending. A separate worker restart preserved a
mode-`0600` marker and its SHA-256 on `/data/telegram`; the restarted process
emitted a heartbeat with zero active jobs, and the marker was then removed and
confirmed absent. A read-only queue query found zero jobs and expired leases.
The dated report records deployment suffixes, evidence, cleanup, deviations,
and the remaining scheduler-soak/non-empty-data/Telegram-session follow-ups.

**Verify**: a dated staging restore report records RPO/RTO observations and passes integrity queries; rollback drill restores the prior API deployment without schema corruption.

### Step 6: Add release observability and alerts

Create dashboards/alerts for API health/readiness, worker heartbeat, pipeline failures, queue age/depth, classification schema errors/latency, review backlog, feed root concentration, export failures, CPU/memory, and PostgreSQL health/storage. Use bounded log queries and protect metrics.

Alert thresholds should reflect personal scale and avoid noise: sustained failure/age, not single retry events. Include service/environment/deployment IDs in logs for diagnosis.

**Verify**: trigger synthetic staging failures for API readiness, a retryable job, classifier invalid schema, and aged review queue; confirm expected signal/alert and no sensitive payload.

**Repository-controlled observability (2026-08-27):** Runtime configuration now
maps Railway project, environment, service, deployment, replica/region, and Git
commit identity into every structured log base when Railway supplies those
variables. A bounded `observability:check` command combines service status,
API health/readiness/protected metrics, worker/scheduler events, and
aggregate-only queue/lease/classifier/export SQL into the initial alert policy.
It suppresses an isolated retry, fails closed, emits no payloads or secrets, and
has deterministic synthetic tests for readiness, queue/lease, sustained retry,
classifier schema/latency, aged review, export, and output-safety signals. The
first read-only staging baseline passed with no alerts at 15:11 UTC. A later
check overlapped an automatic worker deployment before its first heartbeat was
indexed, exposing and correcting a startup-race false positive: a recent
`worker_started` event now satisfies the three-minute liveness grace without
disabling restart-loop detection. The post-grace staging recheck passed with no
alerts at 15:23 UTC. The checker also consumes Railway's bounded raw resource
metrics: CPU/memory alert only after a sufficiently covered ten-minute window
has remained above 85%, while PostgreSQL and the still-attached legacy Telegram
volume alert above 80%. The first read-only resource baseline passed at 22:41
UTC with all reported utilization below 4% and no alerts.

The first scheduler completion exposed that Railway service-level log queries
follow only the latest deployment. The checker now selects bounded recent
`SUCCESS`/`REMOVED` scheduler deployments and recovers completion events across
redeploys. With scheduler enforcement enabled, the staging check found the
03:21 UTC event after the 08:13 UTC redeploy and passed with no alerts.

After merge commit `74603f8` auto-deployed, the scheduler-required check passed
again at 08:43 UTC with all services healthy, one completion recovered across
deployments, low resource utilization, and zero alerts. The bounded official
HN API contract also passed through the production adapter without emitting
source content. Telegram serialized-session validation, sealed staging setup,
bounded ingestion, and restart persistence passed at 11:26 UTC on 2026-08-28.
The next external-dependency gate is Plan 003R classifier shadow validation;
live classification remains disabled.

Current Railway documentation limits native CPU/RAM/disk/egress monitor setup
to the Pro Observability dashboard with email/in-app/webhook routing; it does
not document CLI or IaC creation. Initial thresholds are recorded in the
incident runbook, but native monitor mutations, a destination choice, and live
synthetic staging failures remain approval-gated. Step 6 is therefore in
progress, not complete.

### Step 7: Promote to production with explicit gates

Before production apply/deploy, require:

- release verification green;
- staging soak covering at least one scheduled reconciliation cycle;
- all research acceptance thresholds green, or classification explicitly
  excluded from the release with `CLASSIFIER_ENABLED=false` and no provider
  credentials;
- successful backup/restore and rollback drills;
- no unresolved P1 review/export issue;
- operator approval of cost/service graph and production source/session use.

Deploy with a release summary, watch bounded logs/status, run authenticated smoke tests, ingest a small bounded range, and verify metrics. Initial export remains manual and zero-false-positive gated.

**Verify**: production API/worker/scheduler/PostgreSQL healthy, migrations applied once, bounded ingestion completes, no secret/log leaks, and release checklist is signed/dated in the deploy runbook.

## Test plan

- Clean-checkout release verification and container role smoke tests.
- IaC plan assertion/review before apply.
- Secret-scope and no-build-secret checks.
- Staging bounded HN/Telegram/classifier workflow.
- PostgreSQL backup/restore integrity drill.
- Deployment rollback and serialized-session restart validation; retain the
  historical worker-volume drill as evidence until the legacy volume is removed.
- Synthetic failure/alert tests.
- Production bounded smoke and post-release observation.

## Done criteria

- [x] `.railway/railway.ts` uses current supported IaC and plans the environment-independent base graph without destructive changes.
- [x] Only API pre-deploy runs Prisma migrations.
- [x] Exactly one Railway domain is generated for API and no other staging service is public.
- [x] API, worker, scheduler, PostgreSQL, and the sealed Telegram session have minimum required access.
- [ ] Staging external dependencies were enabled incrementally and all gates passed.
- [x] Backup restore and rollback were actually tested.
- [ ] Metrics/alerts cover service and pipeline failure modes without leaking data.
- [ ] Production deploy is healthy and a bounded end-to-end run succeeds.
- [ ] Plan 007 is marked `DONE`.

## STOP conditions

- Operator has not authorized remote project/resource changes or production deployment.
- `railway config plan` includes an unexpected database/volume deletion or replacement.
- Current Railway IaC/CLI differs materially from this plan; re-query docs and update the plan.
- Prisma migration would run from more than one service.
- Telegram session cannot import from a sealed worker-only secret without
  exposure or interactive login on restart.
- Backup restore or rollback drill fails.
- Any acceptance/evaluation/export gate is red.

## Maintenance notes

Re-run current Railway documentation checks before modifying IaC. Keep API/worker at one replica until queue/session concurrency is explicitly proven. Upgrade Node patch versions through a normal tested release, not an unpinned image tag.
