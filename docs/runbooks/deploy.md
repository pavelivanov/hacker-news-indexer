# Railway deployment runbook

This runbook is the release checklist for the private API, worker, scheduler,
PostgreSQL database, and Telegram session volume. It deliberately separates
read-only planning, staging changes, and production changes.

## Current execution state

As of 2026-08-27:

- Railway CLI `5.45.0` is installed and authenticated to the owner's workspace.
- The checkout is linked to `staging` (environment ID suffix `62dc`) in
  `hacker-news-indexer` (project ID suffix `5328`). The environment contains
  the private `postgres`, `api`, `worker`, and `scheduler` services plus ready
  PostgreSQL and Telegram-session volumes. The separate `production`
  environment (environment ID suffix `1bf3`) remains empty.
- The branch through commit `8de3522` passed `npm run release:verify` twice from
  a clean worktree. Both runs included a clean nine-migration replay, 175 unit
  tests, 45 integration tests, evaluation/export gates, image inspection, and
  API/worker/scheduler container smokes.
- The operator authorized and applied the reviewed five-create, zero-destroy
  staging graph on 2026-08-27. Commit `0d669f4` deployed successfully to all
  four services, the API pre-deploy applied all nine migrations, and Railway's
  `/healthz` deployment gate passed on its injected port `8080`.
- No public domain or application secret has been configured. Telegram and
  classification remain disabled, protected API routes remain fail-closed,
  and production remains untouched.
- Plan 003R is still in progress. Live classifier promotion and production
  promotion remain blocked even if the infrastructure is otherwise healthy.

Do not replace these statements with successful deployment evidence until the
corresponding command and manual check have actually passed.

## Authorization gates

Fresh operator approval is required before each unchecked boundary:

1. [x] Create the Railway project and staging environment.
2. [x] Apply the reviewed IaC graph to staging.
3. [ ] Configure staging application secrets or generate the API domain.
4. [ ] Enable Telegram or another live external dependency in staging.
5. [ ] Apply an IaC plan to production or deploy production code.

Planning and applying are separate approvals. Stop if a plan deletes or
replaces a database or volume, adds a second migration command, exposes a
non-API service, or widens secret scope.

## Intended resource graph

| Resource    | Public     | Start command                                                 | Pre-deploy                  | Persistent state                |
| ----------- | ---------- | ------------------------------------------------------------- | --------------------------- | ------------------------------- |
| `postgres`  | No         | Railway managed                                               | None                        | Railway database volume/backups |
| `api`       | Post-apply | `node --enable-source-maps apps/api/dist/server.js`           | `npm run db:migrate:deploy` | None                            |
| `worker`    | No         | `node --enable-source-maps apps/worker/dist/index.js`         | None                        | `/data/telegram` volume         |
| `scheduler` | No         | `node --enable-source-maps apps/worker/dist/schedule-once.js` | None                        | None                            |

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

| Variable                                                |   API    |        Worker        | Scheduler |             Secret              |
| ------------------------------------------------------- | :------: | :------------------: | :-------: | :-----------------------------: |
| `NODE_ENV=production`                                   |   Yes    |         Yes          |    Yes    |               No                |
| `LOG_LEVEL=info`                                        |   Yes    |         Yes          |    Yes    |               No                |
| `DATABASE_URL=${{postgres.DATABASE_URL}}`               |   Yes    |         Yes          |    Yes    |            Reference            |
| `APP_API_TOKEN`                                         |   Yes    |          No          |    No     |             Sealed              |
| `EXPORT_CONSUMER_TOKEN`                                 | Optional |          No          |    No     | Sealed, distinct from API token |
| `APP_REVIEW_ACTOR_ID`                                   |   Yes    |          No          |    No     |               No                |
| `TELEGRAM_ENABLED`                                      |    No    |         Yes          |    No     |               No                |
| `TELEGRAM_API_ID`                                       |    No    |  Only when enabled   |    No     |       Treat as sensitive        |
| `TELEGRAM_API_HASH`                                     |    No    |  Only when enabled   |    No     |             Sealed              |
| `TELEGRAM_SOURCE_KEY`                                   |    No    |  Only when enabled   |    No     |               No                |
| `TELEGRAM_SESSION_PATH=/data/telegram/telegram.session` |    No    |         Yes          |    No     |            Path only            |
| `CLASSIFIER_ENABLED`                                    |    No    |         Yes          |    No     |               No                |
| `CLASSIFIER_PROVIDER` / `CLASSIFIER_MODEL`              |    No    | Only after Plan 003R |    No     |               No                |
| `CLASSIFIER_API_TOKEN`                                  |    No    | Only after Plan 003R |    No     |             Sealed              |
| `WORKER_*` / `HN_REQUEST_TIMEOUT_MS`                    |    No    |         Yes          |    No     |               No                |

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

Status: **STAGING APPLIED — BASE SERVICES HEALTHY, DOMAIN/SECRETS DEFERRED**

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
- Public-domain count: zero. Runtime evidence shows Railway injects `PORT=8080`;
  after separate approval, generate exactly one environment-scoped API domain
  with `railway domain --service api --environment staging --port 8080 --json`.
- Pre-deploy migration count: one, `npm run db:migrate:deploy` on `api` only.
- Start commands match the intended resource graph above. The scheduler cron is
  `17 3 * * *` and both Telegram and classification remain disabled.
- Secret values were neither defined nor configured. Protected API routes
  therefore remain fail-closed until a separately approved staging secret step.
- Expected monthly cost was not shown by the CLI plan. The operator accepted
  that uncertainty before apply; actual usage still needs monitoring.
- Apply evidence: change-set suffix `0ae6` applied at 10:53 UTC. PostgreSQL,
  API, worker, and scheduler deployments all reached `SUCCESS`; the two volumes
  reached `READY`. Production still had zero service and volume instances in
  the post-apply readback.
- Operator decision: project/environment creation, read-only planning, and the
  reviewed staging apply were authorized on 2026-08-27. Domain creation,
  application secrets, live integrations, and production changes were not.

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
7. [ ] After separate approval, configure `APP_API_TOKEN`, generate one API
       domain on port `8080`, and verify every other service remains private.
8. [ ] Confirm public `GET /healthz` and `GET /readyz` return `200`.
9. [ ] Confirm unauthenticated `/metrics` and `/v1/*` requests are rejected,
       then verify authenticated `/metrics` contains no private labels or payloads.
10. [ ] Observe a worker heartbeat and one scheduled
        `reconciliation_schedule_completed` event, then prove repeated scheduling
        is idempotent.
11. [x] Keep Telegram, live classification, and automatic export disabled.

During first provisioning, the worker began a few seconds before the API
pre-deploy migration finished and emitted bounded `pipeline_job_claim_deferred`
events for the then-missing schema. Its deployment remained healthy, the last
deferral preceded successful migration completion, and no later deferral
appeared in the bounded log tail. The first scheduled run is due at
2026-08-28 03:17 UTC; it was not triggered manually.

Bounded log examples:

```sh
railway logs --service api --environment staging --lines 200 --json
railway logs --service worker --environment staging --lines 200 --json
railway logs --service scheduler --environment staging --lines 100 --json
```

Enable external dependencies one at a time only after approval: HN contract,
Telegram bounded contract/session persistence, classifier shadow after Plan
003R, then reviewed local publication. Automatic export remains disabled.

## Production gate

Production remains blocked until all boxes are evidenced:

- [x] Release verification passed twice from a clean commit.
- [x] Staging IaC plan reviewed with no destructive resource change.
- [x] Private staging base graph deployed; migrations and deployment health passed.
- [ ] Staging soak covered at least one scheduled reconciliation cycle.
- [ ] Bounded HN and Telegram staging checks passed without content/secret logs.
- [ ] Plan 003R promotion gates are green or classification remains explicitly out of scope.
- [ ] Backup restore drill passed with recorded RPO/RTO.
- [ ] API rollback and worker-volume persistence drills passed.
- [ ] Synthetic readiness, retryable-job, invalid-schema, and aged-review alerts fired.
- [ ] No unresolved P1 review/export issue exists.
- [ ] Operator approved cost, service graph, production source/session use, and production deployment.

After production approval, deploy the reviewed commit, watch bounded status and
logs, run health/auth smokes, perform only a small approved ingestion range, and
record the deployment IDs and checklist result here. Do not mark Plan 007 done
before every unchecked item has actual evidence.
