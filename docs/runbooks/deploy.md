# Railway deployment runbook

This runbook is the release checklist for the private API, worker, scheduler,
PostgreSQL database, and sealed Telegram session. It deliberately separates
read-only planning, staging changes, and production changes.

## Current execution state

As of 2026-08-28:

- The unqualified `railway` command resolves to authenticated CLI `5.45.5`.
  This closes the earlier incomplete-asdf-installation blocker; continue to
  reconfirm the version and linked context before every remote mutation.
- The checkout is linked to `staging` (environment ID suffix `62dc`) in
  `hacker-news-indexer` (project ID suffix `5328`). The environment contains
  the private `postgres`, `api`, `worker`, and `scheduler` services plus ready
  PostgreSQL and legacy Telegram-session volumes. This pending change replaces
  file-backed application sessions with a sealed serialized session imported in
  memory; the legacy volume remains attached until rollout verification and
  separately approved removal. The `production` environment (environment ID
  suffix `1bf3`) remains empty.
- The branch through commit `8de3522` passed `npm run release:verify` twice from
  a clean worktree. Both runs included a clean nine-migration replay, 175 unit
  tests, 45 integration tests, evaluation/export gates, image inspection, and
  API/worker/scheduler container smokes.
- The operator authorized and applied the reviewed five-create, zero-destroy
  staging graph on 2026-08-27. Commit `0d669f4` deployed successfully to all
  four services, the API pre-deploy applied all nine migrations, and Railway's
  `/healthz` deployment gate passed on its injected port `8080`.
- The API has one active staging domain,
  `https://api-staging-229b.up.railway.app`, targeting Railway's injected port
  `8080`. `APP_API_TOKEN` is scoped only to the staging API; its redeployment
  and the public health/readiness/auth/metrics smoke passed. The variable is
  sealed/write-only: it remains in API configuration, is absent from CLI value
  readback, and a post-seal authenticated smoke passed. Telegram and
  classification remain disabled, and production remains untouched.
- PR 11 merged as commit `98b9507` and auto-deployed to staging at 13:40 UTC.
  API, worker, scheduler, and PostgreSQL remained `SUCCESS`; the worker emitted
  `worker_heartbeat` at 13:42 UTC; and the authenticated smoke passed against
  the new API deployment.
- The first scheduler cron completed at 03:21 UTC on 2026-08-28 with lock
  acquired, schedule key `2026-08-28`, and zero jobs for the empty staging
  corpus. The same-key PostgreSQL integration test proved one seeded comment
  creates one job across two schedule calls. After commit `2dda9b9` redeployed
  the scheduler, the deployment-history-aware freshness check passed at 08:20
  UTC with scheduler enforcement enabled and zero alerts. See the
  [dated scheduler-soak report](reports/2026-08-28-staging-scheduler-soak.md).
- Merge commit `74603f8` then auto-deployed to all three application services.
  The post-merge scheduler-required observability check passed at 08:43 UTC:
  all four services were healthy, one prior completion was recovered across
  deployments, resource utilization remained low, and no alert fired.
- The bounded official HN API contract passed at 08:42 UTC against one known
  item using the production adapter. It made no mutation and emitted no source
  body. Telegram remains the next external-dependency gate. The operator has
  configured the API credentials and a GramJS session locally. The official
  converter produced a valid mtcute session, the headless authorization check
  passed, and the bounded 100-ID read contract completed without logging source
  bodies. Sealed staging configuration and bounded staging ingestion remain
  approval-gated.
- The read-only PostgreSQL recovery preflight found PITR disabled, no backup
  bucket, no configured backup schedules, and no on-demand backups. The owner
  then authorized a lower-cost logical restore drill: an `age`-encrypted dump
  restored into isolated PostgreSQL 18, matched all bounded integrity checks,
  and passed private API readiness/auth/read verification in 13 minutes 6
  seconds end to end. Scratch services were removed; the unattached scratch
  volume is pending Railway platform deletion. Offline recovery-key retention
  and a representative non-empty-data repeat remain follow-ups.
- The staging API rollback/roll-forward and worker-volume persistence drill
  passed. Both application images passed authenticated smoke with the same nine
  migrations, and a mode-`0600` marker survived the worker restart before being
  removed.
- The repository-controlled observability baseline passed at 2026-08-27 15:11
  UTC with all four services healthy and zero application alerts. A later
  read-only resource baseline added sustained CPU/memory and volume-capacity
  signals; it passed at 22:41 UTC with service utilization below 1% and volume
  utilization below 4%. Railway native monitors, notification routing, and
  live synthetic failures remain unconfigured and require fresh approval.
- Plan 003R is still in progress. Live classifier promotion and production
  promotion remain blocked even if the infrastructure is otherwise healthy.

Do not replace these statements with successful deployment evidence until the
corresponding command and manual check have actually passed.

## Authorization gates

Fresh operator approval is required before each unchecked boundary:

1. [x] Create the Railway project and staging environment.
2. [x] Apply the reviewed IaC graph to staging.
3. [x] Configure the staging API token and generate its single domain.
4. [ ] Enable Telegram or another live external dependency in staging.
5. [x] Create a staging backup/schedule or disposable restore resource and run
       a recovery or rollback drill.
6. [x] Roll back and roll forward the staging API, then restart the worker for
       a volume-persistence drill.
7. [ ] Configure native Railway monitors/notification routing and run live
       synthetic staging alert drills.
8. [ ] Apply an IaC plan to production or deploy production code.

Planning and applying are separate approvals. Stop if a plan deletes or
replaces a database or volume, adds a second migration command, exposes a
non-API service, or widens secret scope.

## Intended resource graph

| Resource    | Public     | Start command                                                 | Pre-deploy                  | Persistent state                                                 |
| ----------- | ---------- | ------------------------------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| `postgres`  | No         | Railway managed                                               | None                        | Railway database volume/backups                                  |
| `api`       | Post-apply | `node --enable-source-maps apps/api/dist/server.js`           | `npm run db:migrate:deploy` | None                                                             |
| `worker`    | No         | `node --enable-source-maps apps/worker/dist/index.js`         | None                        | Sealed in-memory Telegram session; legacy volume pending removal |
| `scheduler` | No         | `node --enable-source-maps apps/worker/dist/schedule-once.js` | None                        | None                                                             |

All three application services build the repository root Dockerfile with the
full npm-workspace context. Keep one replica of each initially. Only `api` gets
the `/healthz` deployment healthcheck. Generate its single Railway domain after
the approved IaC apply; worker, scheduler, and PostgreSQL remain private. Use a
conservative daily scheduler cron; the command derives a UTC-date idempotency
key when no explicit `--key` is supplied.

Use direct Node start commands for long-running roles. The release smoke proved
that an npm wrapper as container PID 1 does not reliably forward Railway's
`SIGTERM` to the worker.

Backend watch paths should include `Dockerfile`, `package.json`,
`package-lock.json`, `apps/api/**`, `apps/worker/**`, and `packages/**`. Changes
limited to docs, plans, evaluation reports, or a future frontend should not
redeploy all backend roles.

## Variable and secret matrix

Use the private database reference `${{postgres.DATABASE_URL}}`. Service names
in Railway references are case-sensitive.

| Variable                                   |   API    |        Worker        | Scheduler |             Secret              |
| ------------------------------------------ | :------: | :------------------: | :-------: | :-----------------------------: |
| `NODE_ENV=production`                      |   Yes    |         Yes          |    Yes    |               No                |
| `LOG_LEVEL=info`                           |   Yes    |         Yes          |    Yes    |               No                |
| `DATABASE_URL=${{postgres.DATABASE_URL}}`  |   Yes    |         Yes          |    Yes    |            Reference            |
| `APP_API_TOKEN`                            |   Yes    |          No          |    No     |             Sealed              |
| `EXPORT_CONSUMER_TOKEN`                    | Optional |          No          |    No     | Sealed, distinct from API token |
| `APP_REVIEW_ACTOR_ID`                      |   Yes    |          No          |    No     |               No                |
| `TELEGRAM_ENABLED`                         |    No    |         Yes          |    No     |               No                |
| `TELEGRAM_API_ID`                          |    No    |  Only when enabled   |    No     |       Treat as sensitive        |
| `TELEGRAM_API_HASH`                        |    No    |  Only when enabled   |    No     |             Sealed              |
| `TELEGRAM_SOURCE_KEY`                      |    No    |  Only when enabled   |    No     |               No                |
| `TELEGRAM_SESSION`                         |    No    |  Only when enabled   |    No     |             Sealed              |
| `CLASSIFIER_ENABLED`                       |    No    |         Yes          |    No     |               No                |
| `CLASSIFIER_PROVIDER` / `CLASSIFIER_MODEL` |    No    | Only after Plan 003R |    No     |               No                |
| `CLASSIFIER_API_TOKEN`                     |    No    | Only after Plan 003R |    No     |             Sealed              |
| `WORKER_*` / `HN_REQUEST_TIMEOUT_MS`       |    No    |         Yes          |    No     |               No                |

Omit `EXPORT_CONSUMER_TOKEN` to keep consumer access disabled during the first
staging rollout. Start staging with `TELEGRAM_ENABLED=false` and
`CLASSIFIER_ENABLED=false`. The current worker has no promoted live classifier
adapter; do not set provider credentials merely to silence disabled jobs.

Never put secrets in the IaC source, Docker build arguments, command-line
arguments, plan output, deployment notes, or screenshots. Inspect only variable
names when checking scope:

```sh
railway variable list --service api --environment staging --json | jq -r 'keys[]'
railway variable list --service worker --environment staging --json | jq -r 'keys[]'
railway variable list --service scheduler --environment staging --json | jq -r 'keys[]'
```

Railway's JSON contains raw values before `jq` reduces it, so never run these
commands without the filter, enable shell tracing, or save the intermediate
JSON. The API list must not contain Telegram or classifier keys. The scheduler list
must contain neither integration credentials nor API credentials.

## Project and IaC workflow

Run these steps only after the project-creation authorization gate:

1. Reconfirm account and workspace with `railway whoami --json`.
2. Create and link the explicitly named project with the explicit workspace.
3. Confirm `railway status --json` before any configuration command.
4. Run `railway config init`; edit only the generated
   `.railway/railway.ts`. Do not introduce `railway.json` or `railway.toml`.
5. Define the environment-independent resource graph, but do not apply it.
6. Run `railway config plan --verbose`. Do not use `--show-values`.
7. Compare the plan to the resource graph and secret matrix above.
8. Save only the redacted summary below, then request separate apply approval.

### Redacted IaC plan summary

Status: **STAGING APPLIED — API DOMAIN/AUTH SMOKE HEALTHY**

The 2026-08-27 09:59 UTC production plan is superseded. It contained an
environment-derived API domain, but a staging context probe showed Railway CLI
`5.45.0` invokes the TypeScript program with an empty context object. That made
the same file render the production domain while targeting staging. The domain
was removed from IaC instead of relying on a mismatched name or a manually
duplicated environment selector.

- Plan time: 2026-08-27 10:35 UTC with Railway CLI `5.45.0`.
- Project: `hacker-news-indexer`, project ID suffix `5328`.
- Target: `staging`, environment ID suffix `62dc`.
- Diff: five additions (`postgres`, `telegram-session`, `api`, `worker`, and
  `scheduler`), zero updates, and zero destroys. Diagnostics were empty.
- Database/volume deletion or replacement count: zero.
- Plan-time public-domain count: zero. After separate approval, exactly one
  environment-scoped API domain was generated on injected port `8080`; worker,
  scheduler, and PostgreSQL still have none.
- Pre-deploy migration count: one, `npm run db:migrate:deploy` on `api` only.
- Start commands match the intended resource graph above. The scheduler cron is
  `17 3 * * *` and both Telegram and classification remain disabled.
- No secret value appeared in the plan. `APP_API_TOKEN` was later streamed via
  stdin to the staging API only; its value was not placed in arguments or
  readback output.
- Expected monthly cost was not shown by the CLI plan. The operator accepted
  that uncertainty before apply; actual usage still needs monitoring.
- Apply evidence: change-set suffix `0ae6` applied at 10:53 UTC. PostgreSQL,
  API, worker, and scheduler deployments all reached `SUCCESS`; the two volumes
  reached `READY`. Production still had zero service and volume instances in
  the post-apply readback.
- Operator decision: project/environment creation, read-only planning, the
  reviewed staging apply, the API token, one API domain, and read-only smoke
  were authorized on 2026-08-27. Live integrations and production changes were
  not.

The current Railway IaC beta plans resources only against the linked
environment. The environment must be created and linked separately, and the
current CLI's missing evaluator context means environment-derived configuration
must not be committed until the upstream behavior is fixed and re-verified.

Do not paste raw runner JSON, variable values, domains containing credentials,
or complete project/service IDs into this repository.

## Staging rollout

Current checklist:

1. [x] Apply exactly the reviewed plan without destructive confirmation.
2. [x] Read back environment configuration, service status, volumes, and
       production isolation without exposing variable values.
3. [x] Deploy commit `0d669f4`; all four staging deployments reached `SUCCESS`.
4. [x] Apply all nine migrations once through the API pre-deploy command.
5. [x] Pass Railway's API `/healthz` deployment gate on injected port `8080`.
6. [x] Confirm the worker starts with Telegram and classification disabled.
7. [x] Configure `APP_API_TOKEN` on the API only, generate one API domain on
       port `8080`, and verify every other service remains private.
8. [x] Confirm public `GET /healthz` and `GET /readyz` return `200`.
9. [x] Confirm unauthenticated `/metrics` and `/v1/*` requests are rejected,
       then verify authenticated `/metrics` contains no private labels or payloads.
10. [x] Seal `APP_API_TOKEN` through Railway's dashboard, verify CLI value
        readback omits it, and confirm a post-seal authenticated smoke still
        passes.
11. [x] Observe a worker heartbeat and one scheduled
        `reconciliation_schedule_completed` event, then prove repeated scheduling
        is idempotent.
12. [x] Keep Telegram, live classification, and automatic export disabled.
13. [x] Pass the bounded official HN API read contract without source-body
        logging.
14. [x] Validate the serialized Telegram session locally and pass the bounded
        100-ID Telegram read contract without source-body logging.
15. [ ] Seal the session on the worker, enable one staging worker, and pass one
        bounded staging ingestion after separate approval.

During first provisioning, the worker began a few seconds before the API
pre-deploy migration finished and emitted bounded `pipeline_job_claim_deferred`
events for the then-missing schema. Its deployment remained healthy, the last
deferral preceded successful migration completion, and no later deferral
appeared in the bounded log tail.

After commit `98b9507` auto-deployed, the worker emitted a safe heartbeat at
2026-08-27 13:42 UTC. The first cron then completed at 03:21 UTC on 2026-08-28
with its daily key and no jobs for the empty corpus. The repository's
PostgreSQL integration test repeated one schedule key against a seeded comment
and produced one job total. This closes the empty-corpus soak; repeat against a
non-empty live staging corpus after bounded ingestion is authorized.

Bounded log examples:

```sh
railway logs --service api --environment staging --lines 200 --json
railway logs --service worker --environment staging --lines 200 --json
railway logs --service scheduler --environment staging --lines 100 --json
```

After the token and domain are separately approved and configured, run the
read-only smoke from a clean checkout:

```sh
npm run staging:smoke -- https://<generated-api-domain>
```

The command reads `APP_API_TOKEN` from the gitignored `.env`, never accepts the
token on the command line, rejects redirects, caps every response at 128 KiB,
requires at least 32 non-whitespace token characters, and prints only a
pass/fail summary. It verifies public liveness/readiness, fail-closed
unauthenticated `/metrics` and `/v1/*`, authenticated metrics, the expected
metric families, and the absence of credentials, URLs, or unexpected labels in
the metrics response. It does not enqueue ingestion or mutate data.

The 2026-08-27 11:36 UTC smoke passed all five checks against
`https://api-staging-229b.up.railway.app`. Railway CLI `5.45.1` printed a
generic create failure even though the domain was created; immediate readback
showed exactly one `ACTIVE` service domain on port `8080`. Always inspect
`railway domain list` after this error before retrying, or a retry could attempt
to create an unintended second domain.

Enable external dependencies one at a time only after approval: HN contract,
Telegram bounded contract/session persistence, classifier shadow after Plan
003R, then reviewed local publication. Automatic export remains disabled.

The HN contract passed on 2026-08-28 with one known-item read through the
production adapter. The Telegram gate now uses a native mtcute, GramJS,
Telethon v1, or Pyrogram `TELEGRAM_SESSION` secret: the worker converts supported
external formats, imports the result into memory, and validates it headlessly,
with no runtime login or session-file upload. The string still represents an
authorized Telegram identity and must be sealed on the worker only. The legacy
staging volume remains attached and unused until deletion is separately
reviewed and approved.

At 2026-08-28 10:31 UTC, the supplied GramJS session passed conversion and
headless authorization, then the exact 100-ID Telegram contract passed through
the production adapter. The command emitted only the safe format label and test
summary. No identity, session value, message body, or Railway mutation was
produced.

## Production gate

Production remains blocked until all boxes are evidenced:

- [x] Release verification passed twice from a clean commit.
- [x] Staging IaC plan reviewed with no destructive resource change.
- [x] Private staging base graph deployed; migrations and deployment health passed.
- [x] Public API health/readiness/auth/metrics smoke passed without secret output.
- [x] Staging soak covered at least one scheduled reconciliation cycle.
- [x] Bounded HN live contract passed without content/secret logs.
- [ ] Bounded Telegram staging check passed without content/secret logs.
- [ ] Plan 003R promotion gates are green or classification remains explicitly out of scope.
- [x] Backup restore drill passed with recorded RPO/RTO.
- [x] API rollback and worker-volume persistence drills passed.
- [ ] Synthetic readiness, retryable-job, invalid-schema, and aged-review alerts fired.
- [ ] No unresolved P1 review/export issue exists.
- [ ] Operator approved cost, service graph, production source/session use, and production deployment.

After production approval, deploy the reviewed commit, watch bounded status and
logs, run health/auth smokes, perform only a small approved ingestion range, and
record the deployment IDs and checklist result here. Do not mark Plan 007 done
before every unchecked item has actual evidence.
