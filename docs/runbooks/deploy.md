# Railway deployment runbook

This runbook is the release checklist for the private API, worker, scheduler,
PostgreSQL database, and Telegram session volume. It deliberately separates
read-only planning, staging changes, and production changes.

## Current execution state

As of 2026-08-27:

- Railway CLI `5.45.0` is installed and authenticated to the owner's workspace.
- The checkout is linked to the newly created, empty `hacker-news-indexer`
  project (project ID suffix `5328`). Its only remote environment is the empty
  `production` environment (environment ID suffix `1bf3`).
- The branch through commit `8de3522` passed `npm run release:verify` twice from
  a clean worktree. Both runs included a clean nine-migration replay, 175 unit
  tests, 45 integration tests, evaluation/export gates, image inspection, and
  API/worker/scheduler container smokes.
- The operator authorized empty-project creation and read-only IaC planning.
  No service, database, volume, staging environment, secret, domain, or
  deployment has been created. `railway config apply`, staging changes, and
  production changes remain unauthorized.
- Plan 003R is still in progress. Live classifier promotion and production
  promotion remain blocked even if the infrastructure is otherwise healthy.

Do not replace these statements with successful deployment evidence until the
corresponding command and manual check have actually passed.

## Authorization gates

Fresh operator approval is required before each of these boundaries:

1. Create a Railway project or any service, environment, database, or volume.
2. Apply an IaC plan to staging.
3. Enable Telegram or another live external dependency in staging.
4. Apply an IaC plan to production or deploy production code.

Planning and applying are separate approvals. Stop if a plan deletes or
replaces a database or volume, adds a second migration command, exposes a
non-API service, or widens secret scope.

## Intended resource graph

| Resource    | Public | Start command                                                 | Pre-deploy                  | Persistent state                |
| ----------- | ------ | ------------------------------------------------------------- | --------------------------- | ------------------------------- |
| `postgres`  | No     | Railway managed                                               | None                        | Railway database volume/backups |
| `api`       | Yes    | `node --enable-source-maps apps/api/dist/server.js`           | `npm run db:migrate:deploy` | None                            |
| `worker`    | No     | `node --enable-source-maps apps/worker/dist/index.js`         | None                        | `/data/telegram` volume         |
| `scheduler` | No     | `node --enable-source-maps apps/worker/dist/schedule-once.js` | None                        | None                            |

All three application services build the repository root Dockerfile with the
full npm-workspace context. Keep one replica of each initially. Only `api` gets
a Railway domain and `/healthz` deployment healthcheck. Use a conservative
daily scheduler cron; the command derives a UTC-date idempotency key when no
explicit `--key` is supplied.

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
5. Define both `staging` and `production`, but do not apply either environment.
6. Run `railway config plan --verbose`. Do not use `--show-values`.
7. Compare the plan to the resource graph and secret matrix above.
8. Save only the redacted summary below, then request separate apply approval.

### Redacted IaC plan summary

Status: **REVIEWED READ-ONLY — NOT APPLIED**

- Plan time: 2026-08-27 09:59 UTC with Railway CLI `5.45.0`.
- Project: `hacker-news-indexer`, project ID suffix `5328`.
- Target: `production`, environment ID suffix `1bf3`.
- Diff: five additions (`postgres`, `telegram-session`, `api`, `worker`, and
  `scheduler`), zero updates, and zero destroys. Diagnostics were empty.
- Database/volume deletion or replacement count: zero.
- Public-domain count: one, assigned only to `api` on container port `3000`.
- Pre-deploy migration count: one, `npm run db:migrate:deploy` on `api` only.
- Start commands match the intended resource graph above. The scheduler cron is
  `17 3 * * *` and both Telegram and classification remain disabled.
- Secret values were neither defined nor configured. Protected API routes
  therefore remain fail-closed until a separately approved staging secret step.
- Expected monthly cost was not shown by the CLI plan and remains pending an
  operator review before apply.
- Operator decision: project creation and this read-only plan were authorized
  on 2026-08-27. No apply approval was given.

The current Railway IaC beta plans resources only against the linked
environment; declaring `staging` in the graph did not create or plan a staging
environment. Create and link `staging` only after a separate remote-change
approval, then run and review a fresh staging-targeted plan before any apply.

Do not paste raw runner JSON, variable values, domains containing credentials,
or complete project/service IDs into this repository.

## Staging rollout

After staging apply approval:

1. Apply exactly the reviewed plan without `--confirm-destructive`.
2. Inspect `railway environment config --json` and `railway status --json`;
   resolve names and IDs again.
3. Deploy the exact release commit to staging.
4. Read at most 200 build/deploy log lines per role. Search for errors and
   expected role markers, never source bodies or secrets.
5. Confirm `GET /healthz` returns `200` and `GET /readyz` returns `200`.
6. Confirm an unauthenticated `/metrics` and `/v1/*` request is rejected.
7. Confirm authenticated `/metrics` works and contains no labels or payloads
   with private content.
8. Confirm worker `worker_started` and `worker_heartbeat` events, one scheduler
   `reconciliation_schedule_completed` event, and idempotent repeated scheduling.
9. Keep Telegram and live classification disabled. A live ingestion request is
   not part of this initial smoke.

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
- [x] IaC plan reviewed with no destructive resource change.
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
