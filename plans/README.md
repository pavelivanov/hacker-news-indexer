# Implementation Plans

Generated on 2026-08-24 from `docs/telegram-hn-technical-knowledge-project-research-plan.md` using the improve planning workflow. Execute in the order below unless the dependency graph permits parallel work. Every executor must read its plan fully, honor its STOP conditions, run every verification gate, and update its status row.

## Planning baseline

- The repository is greenfield: it has no commit at planning time, no package manifest, no source code, no tests, and no CI.
- Research-plan SHA-256 at planning time: `f1bac94fbe96a68df4ef82db69e1dbc9b0a2c4ad61268802d4e95e5bdbfa14b7`.
- The research document is the product source of truth. These plans refine its sequencing but do not change its product boundaries.
- Phase 0 is product/taxonomy validation. Legal or permission approval is not a blocker under the owner's private, personal-use decision.

## Locked implementation decisions

- Backend-first, private single-user application.
- Node.js 24 LTS, TypeScript, npm workspaces, Hono, PostgreSQL, Prisma, Docker, Railway.
- Node.js is the runtime; Bun is not part of v1.
- The selected HN comment is canonical content. Telegram is selection/provenance, and the resolved HN root is bounded context.
- Default initial selection source: Telegram `@hn_best_comments`; direct HN `/bestcomments` remains a replaceable future adapter.
- No sibling-comment traversal and no external-page fetching in v1.
- No Redis in v1; jobs use PostgreSQL.
- All classifier claims require validated evidence spans, and all URLs must come from supplied HN URL candidates.
- FindThatProject export is pull-based, versioned, manually approved during rollout, and limited to eligible Discoveries.
- A frontend is optional and deliberately comes after the backend contracts stabilize.

## Implementation refinements to the research roadmap

1. Split the research document's combined `0005_review_and_export` migration into `0005_review` and `0006_export`. Review is required for classifier shadow mode and therefore must exist before export.
2. Use Railway Infrastructure as Code in `.railway/railway.ts`. Current Railway documentation deprecates `railway.json`/`railway.toml` for new services with a 2026-12-01 cutoff.
3. Use `@mtcute/node` as the preferred MTProto candidate, subject to the contract gate in Plan 002. Its current API exposes bounded `getHistory`/`iterHistory` and exact-ID `getMessages`; GramJS is archived at planning time.
4. Pin Prisma's current stable major during Plan 001 and do not adopt Prisma 8 prereleases. The executor must re-check current stable documentation if execution occurs after material version drift.

## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
|---|---|---|---|---|---|
| 001 | Establish the project foundation and decision record | P1 | L | — | DONE |
| 002 | Implement deterministic selection ingestion and HN resolution | P1 | L | 001 | DONE |
| 003 | Implement grounded classification and the evaluation harness | P1 | L | 002 | BLOCKED (Sol prompt-v3 failed the single sealed holdout) |
| 003R | Recover classifier generalization on a fresh evaluation cycle | P1 | M | 003 implementation | IN PROGRESS (cycle locks and shadow-only safety complete; fresh v2 data pending) |
| 004 | Implement subjects, discoveries, notes, and human review | P1 | L | 003 implementation | DONE |
| 005 | Implement the private knowledge-feed APIs and reconciliation | P1 | L | 004 | DONE |
| 006 | Implement the FindThatProject export outbox | P2 | M | 004 | DONE |
| 007 | Harden and deploy the API, worker, and PostgreSQL on Railway | P1 | L | 005, 006 | IN PROGRESS (sealed API smoke passed; soak, recovery, alerts, and integrations pending) |
| 008 | Add the optional Vite/React reader and review UI | P3 | L | 005 | TODO |

Status values: `TODO`, `IN PROGRESS`, `DONE`, `BLOCKED (<one-line reason>)`, or `REJECTED (<one-line rationale>)`.

Updating the relevant status row in this file is always in scope for an executor, even when a plan's file list does not repeat `plans/README.md`.

## Dependency graph

```text
001 foundation
  -> 002 ingestion + HN resolution
      -> 003 classification + evaluation (v1 promotion blocked)
          -> 003R fresh evaluation recovery -----------+
          -> 004 subjects + mandatory human review ----+
              -> 005 feed + reconciliation -> 007 Railway production
              -> 006 export ---------------/
              -> 008 optional web UI
```

Plan 004 may proceed while 003R runs, but all model-derived decisions remain
inactive and mandatory-review until 003R passes. Plans 005 and 006 may run in
parallel after Plan 004; they may consume only manually approved content while
003R is incomplete. Plan 008 is not on the backend v1 critical path.

## Global verification gate

After Plan 001, every backend plan must finish with all of these commands passing from the repository root:

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test
docker compose up -d postgres
npm run db:test:wait
npm run db:migrate:deploy
npm run test:integration
docker compose down
docker build -t hn-knowledge:verify .
```

Plans that change classification must also pass `npm run test:evaluation`. Plans that change Prisma schema must run a clean-database migration test before being marked done.

## Findings considered and rejected

- **Python/Telethon service:** rejected because the owner selected a TypeScript/Node.js backend.
- **Bun runtime:** rejected for v1 to reduce runtime and Railway compatibility risk.
- **Redis queue:** rejected for v1 because a PostgreSQL lease queue is sufficient at personal scale.
- **Automatic external-page fetching:** rejected for v1 because it expands SSRF, licensing, and grounding risk without being needed for the first corpus.
- **Frontend-first delivery:** rejected because deterministic provenance and review contracts must stabilize first.
