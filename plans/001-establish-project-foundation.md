# Plan 001: Establish the project foundation and decision record

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving on. If a STOP condition occurs, stop and report; do not improvise. When done, update Plan 001 in `plans/README.md`.
>
> **Drift check (run first)**: `shasum -a 256 docs/telegram-hn-technical-knowledge-project-research-plan.md`
> Expected planning baseline: `f1bac94fbe96a68df4ef82db69e1dbc9b0a2c4ad61268802d4e95e5bdbfa14b7`. If it differs, read the changed research plan and stop if any locked decision or scope boundary conflicts with this plan.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: architecture / DX / tests
- **Planned at**: unborn repository with no `HEAD`, 2026-08-24

## Why this matters

The repository contains only research. This plan creates a reproducible Node.js/TypeScript baseline with strict verification, an API/worker process split, PostgreSQL/Prisma connectivity, and Docker parity. Later plans must not invent tooling or architecture independently.

## Current state

- `docs/telegram-hn-technical-knowledge-project-research-plan.md` is the only project artifact.
- No `package.json`, lockfile, application, schema, tests, CI, or initial commit exists.
- Product invariants: private personal use; canonical HN comments; Telegram as occurrence/provenance; no sibling traversal; no external fetching; grounded URLs/evidence; backend before frontend.
- Current platform choices: Node.js 24 LTS, TypeScript, Hono Node adapter, PostgreSQL, Prisma stable, Docker, Railway.

## Commands you will establish

| Purpose | Command | Expected on success |
|---|---|---|
| Install | `npm ci` | exit 0; lockfile unchanged |
| Format | `npm run format:check` | exit 0; no files rewritten |
| Lint | `npm run lint` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0; no TypeScript errors |
| Build | `npm run build` | exit 0; API and worker output created |
| Unit tests | `npm test` | exit 0; all tests pass |
| Integration | `npm run test:integration` | exit 0; foundation DB smoke test passes |
| Docker | `docker build -t hn-knowledge:verify .` | exit 0 |

## Suggested executor toolkit

- Use current-documentation lookup before choosing package versions or copying Hono/Prisma setup.
- Follow Hono's Node server pattern and export the `Hono` app separately from `serve(...)`, allowing tests to call `app.request(...)`.
- Follow Prisma's current stable PostgreSQL driver-adapter setup. At planning time this is Prisma 7 with `@prisma/adapter-pg`; do not use `@next`.
- Relevant current sources: [Node releases](https://nodejs.org/en/about/previous-releases), [Hono Node.js](https://hono.dev/docs/getting-started/nodejs), [Hono testing](https://hono.dev/docs/guides/testing), [Prisma PostgreSQL](https://www.prisma.io/docs/orm/overview/databases/postgresql).

## Scope

**In scope**:

- Root tooling: `package.json`, `package-lock.json`, `.npmrc`, `.nvmrc`, `tsconfig.base.json`, ESLint/Prettier config, `.gitignore`, `.env.example`.
- Workspace manifests and base TypeScript configs under `apps/api`, `apps/worker`, and `packages/{config,contracts,domain,ports,application,adapters,db}`.
- `apps/api/src/app.ts`, `apps/api/src/server.ts`, and `apps/api/src/routes/health.ts`.
- `apps/worker/src/index.ts` with signal-safe lifecycle but no jobs yet.
- `packages/config/src/env.ts` and tests.
- `packages/db/prisma/schema.prisma`, `packages/db/prisma.config.ts`, `packages/db/src/client.ts`.
- `Dockerfile`, `compose.yaml`, `.dockerignore`.
- `.github/workflows/ci.yml`.
- `docs/decisions/0001` through `0004` and `docs/annotation-guide.md`.
- Foundation tests under `tests/unit` and `tests/integration`.

**Out of scope**:

- Telegram or HN network calls.
- Domain tables and production migrations.
- Classifier/provider integration.
- Reader/review/export endpoints.
- Railway project creation or remote deployment.
- Any frontend files.

## Git workflow

- Branch: `codex/001-project-foundation`.
- Adopt Conventional Commits because no history exists; examples: `chore: scaffold node workspaces`, `test: add foundation smoke tests`.
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Record decisions and v1 boundaries

Create:

- `docs/decisions/0001-private-personal-scope.md`: private single-user scope; legal approval is not a Phase 0 gate; revisit if public, commercial, or multi-user.
- `docs/decisions/0002-runtime-and-platform.md`: Node.js 24 LTS, npm, TypeScript, Hono, Prisma/PostgreSQL, Docker, Railway; Bun rejected for v1.
- `docs/decisions/0003-content-and-source-boundaries.md`: Telegram is the default selection occurrence; selected HN comment is canonical; root story is context; direct HN source is a future adapter; never fetch siblings or arbitrary external pages.
- `docs/decisions/0004-retention-and-secrets.md`: retain Telegram IDs, entity/link data, timestamps, and hashes; do not persist Telegram body text after successful canonical HN resolution by default; retain HN bodies until deletion/dead reconciliation; sessions and credentials live outside the database and logs.
- `docs/annotation-guide.md`: definitions and examples for `DISCOVERY`, `EXPERT_NOTE`, `REJECTED`, and `REVIEW`, evidence origins, subject types, note types, and review reasons copied from the research plan.

Do not add a legal approval checklist.

**Verify**: `test -f docs/decisions/0004-retention-and-secrets.md && rg -n "DISCOVERY|EXPERT_NOTE|REJECTED|REVIEW" docs/annotation-guide.md` → exit 0 and all four decisions appear.

### Step 2: Scaffold strict npm workspaces

Pin Node `24.19.0` in `.nvmrc` and the Docker image. Set root `engines.node` to `>=24 <25`. Use npm workspaces for `apps/*` and `packages/*`; do not add Turborepo yet.

Use ESM everywhere (`"type": "module"`). Use strict TypeScript with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`, and source maps. Package names must be stable and explicit, for example `@hn-knowledge/api`, `@hn-knowledge/db`, and `@hn-knowledge/domain`.

Root scripts must provide the commands in the command table plus:

- `dev:api`, `dev:worker`;
- `start:api`, `start:worker`;
- `db:generate`, `db:migrate:dev`, `db:migrate:deploy`, `db:validate`, `db:test:wait`, `db:test:reset`;
- `test:evaluation` (may initially pass with a documented no-corpus message and zero tests).

Set npm to save exact dependency versions. Pin the current stable Prisma 7 release; if npm's stable release is Prisma 8 or later, stop and re-plan the Prisma setup instead of silently adopting a new major.

**Verify**: `node --version && npm install && npm ci && git diff --exit-code -- package-lock.json` → Node 24.x, both installs exit 0, clean lockfile after `npm ci`.

### Step 3: Implement validated, redacted configuration

In `packages/config/src/env.ts`, parse environment variables once using a strict schema. Include `NODE_ENV`, `LOG_LEVEL`, `PORT`, `DATABASE_URL`, `APP_API_TOKEN`, timeouts, and disabled-by-default placeholders for Telegram/classifier settings. Export typed config and a redacted diagnostic representation that never includes values for keys containing `TOKEN`, `SECRET`, `HASH`, `SESSION`, `PASSWORD`, or database URLs.

Do not require Telegram or classifier secrets merely to start the API health route or run unit tests.

**Verify**: `npm test -- --run tests/unit/config.test.ts` → tests prove invalid numeric values fail, defaults apply, and secret values never appear in redacted output.

### Step 4: Create testable Hono API and worker shells

- `apps/api/src/app.ts` exports a constructed `Hono` app without opening a socket.
- `apps/api/src/server.ts` calls `serve` from `@hono/node-server`, binds `0.0.0.0`, reads `PORT`, and handles `SIGINT`/`SIGTERM` with graceful close.
- Add `GET /healthz` returning HTTP 200 with `{ "status": "ok" }` and no database dependency.
- Add an error handler that logs a request/correlation ID but never returns stacks or source bodies.
- `apps/worker/src/index.ts` establishes the same logging/config lifecycle, waits without busy-looping, and exits cleanly on signals. It must not claim jobs yet.

**Verify**: `npm test -- --run tests/unit/api-health.test.ts` → `app.request('/healthz')` returns 200 and exact safe JSON; `npm run build` exits 0.

### Step 5: Establish Prisma/PostgreSQL connectivity without domain tables

Configure Prisma for PostgreSQL using the current stable Prisma 7 structure, a custom generated-client output under `packages/db/src/generated`, and the `pg` driver through `@prisma/adapter-pg`. Keep connection creation in `packages/db/src/client.ts`; tests and processes must close pools cleanly.

Add `GET /readyz` that checks PostgreSQL with a bounded timeout and returns 200 only when reachable; keep `/healthz` independent.

Do not create product models or production migrations in this plan.

**Verify**: `docker compose up -d postgres && npm run db:validate && npm run db:generate && npm run test:integration -- --run tests/integration/db-readiness.test.ts` → all exit 0; `/readyz` is 200 with DB up and 503 with an intentionally invalid test URL.

### Step 6: Build one reproducible container for two process roles

Create a multi-stage `Dockerfile` based on `node:24.19.0-bookworm-slim`. Use `npm ci`, generate Prisma client, build workspaces, copy only runtime artifacts/dependencies, run as a non-root user, and make the default command start the API. Railway will override the command for the worker.

`compose.yaml` must pin PostgreSQL to a stable major (17 is the conservative baseline), include a healthcheck, use named volumes, and expose only local development ports. Never bake `.env` or secrets into the image.

**Verify**: `docker build -t hn-knowledge:verify .` → exit 0; start the image against Compose PostgreSQL and confirm `/healthz` returns 200.

### Step 7: Add CI as the baseline gate

Create `.github/workflows/ci.yml` for pull requests and pushes. It must use Node 24, npm cache, PostgreSQL service, `npm ci`, format check, lint, typecheck, build, unit tests, integration tests, Prisma validation, and a Docker build. Do not run live Telegram, HN, classifier, Railway, or evaluation-provider calls in normal CI.

**Verify**: validate the YAML locally if a checker exists, then run the complete global gate from `plans/README.md` → every command exits 0.

## Test plan

- `tests/unit/config.test.ts`: defaults, strict parsing, redaction.
- `tests/unit/api-health.test.ts`: Hono `app.request`, 404, safe 500 response, correlation ID.
- `tests/integration/db-readiness.test.ts`: ready/unready transitions and pool shutdown.
- A container smoke script that starts the API image and polls `/healthz` with a bounded timeout.

## Done criteria

- [ ] All four ADRs and the annotation guide exist and reflect research terminology.
- [ ] Node 24.19.0, npm lockfile, strict TypeScript, workspace boundaries, and exact dependency pinning are present.
- [ ] API and worker build and shut down gracefully.
- [ ] `/healthz` and `/readyz` have automated tests.
- [ ] Prisma generate/validate and PostgreSQL integration tests pass.
- [ ] Docker image builds and runs as non-root.
- [ ] The global verification gate passes.
- [ ] `plans/README.md` marks Plan 001 `DONE`.

## STOP conditions

- The research plan changed in a way that conflicts with a locked decision.
- Node 24 is no longer supported by the selected current stable Hono or Prisma version.
- Prisma stable has moved to a new major whose setup differs materially from the documented Prisma 7 driver-adapter/config pattern.
- Building a non-root image requires storing a credential or Telegram session inside the image.
- Any foundational test requires live external network access.

## Maintenance notes

Keep `app.ts` free of socket startup so route tests remain fast. Keep all runtime configuration validation centralized. Review every dependency-major upgrade against Node, Prisma generation, the Docker image, and Railway before merging.
