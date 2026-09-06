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
| 003R | Recover classifier generalization on a fresh evaluation cycle | P1 | M | 003 implementation | DONE (assist-only; v3 failed primary-class annotation kappa at 0.7327) |
| 004 | Implement subjects, discoveries, notes, and human review | P1 | L | 003 implementation | DONE |
| 005 | Implement the private knowledge-feed APIs and reconciliation | P1 | L | 004 | DONE |
| 006 | Implement the FindThatProject export outbox | P2 | M | 004 | DONE |
| 007 | Harden and deploy the API, worker, and PostgreSQL on Railway | P1 | L | 005, 006 | IN PROGRESS (production base graph healthy and fail-closed smoke passed; token seal, live alerts, and bounded ingestion pending) |
| 008 | Add the optional Vite/React reader and review UI | P3 | L | 005 | TODO |
| 009 | Resolve the classifier endgame via rubric calibration with a pre-registered assist-only fallback | P1 | M | none | DONE (v3 annotation gate selected the pre-registered assist-only endpoint) |
| 010 | Fix four correctness defects in the classification core | P1 | M | none | DONE (branch advisor/010-correctness-core, reviewed) |
| 011 | Make evaluation crash states recoverable | P2 | M | none (before first live holdout; see 009 Step 4) | DONE (branch advisor/011-crash-recovery, reviewed) |
| 012 | Hygiene batch: dead fixtures, doc drift, root strays, @types/node, AGENTS.md | P2 | S | none | DONE (branch advisor/012-hygiene, reviewed) |
| 013 | Deliver a local browser inbox for manual review | P1 | L | 004 and 005 implementations | DONE (local browser, draft/approval, and full verification passed) |
| 014 | Browse classifier results with optional corrections | P1 | M | 013 | DONE (98 local results; correction storage and full verification passed) |
| 015 | Automatic fresh results and processing recovery | P1 | L | 014 | DONE (20 new live results; bounded worker, recovery controls, and full verification passed) |
| 016 | Search classifier results and save useful items | P1 | M | 015 | DONE (search, persistent bookmarks, migration, browser/accessibility, and full verification passed) |

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
              -> 013 local manual-review browser MVP (complete)
                  -> 014 classifier results and optional feedback
                      -> 015 automatic fresh results and recovery
                          -> 016 search and saved results
```

Plan 003R has closed at the assist-only endpoint. Model-derived decisions
remain inactive for the approved reader/export paths; no automatic classifier
promotion or further evaluation cycle is permitted. Plans 005 and 006 may
consume only manually approved content. On 2026-09-05 the owner authorized
private browsing of classifier results without approval, with optional feedback
under [ADR 0007](../docs/decisions/0007-classifier-results-feedback.md) and
[Plan 014](014-classifier-results-and-feedback.md). This does not revise the
historical evaluation result. Plan 008 is not on the backend v1 critical path.

On 2026-09-04 the owner selected [Plan 013](013-local-manual-review-mvp.md)
as the next product milestone: local browser review of existing sources, both
Discoveries and Expert notes, editable drafts, and explicit approval. It depends
on the existing 004/005 implementations, not classifier promotion or completion
of hosted deployment. It delivers a focused subset of Plan 008 plus the missing
first-human-decision backend path. Execute 013 before the broader 008 work;
008 remains TODO and must reuse the resulting workspace. The classifier stays
disabled and terminal evaluation decisions remain unchanged. The supporting
[implementation audit](reports/2026-09-04-classifier-implementation-audit.md)
records the evidence and separately deferred classifier/runtime defects.

On 2026-09-05, all six Plan 013 steps completed. The
[completion report](reports/013-manual-review-completion.md) records storage,
atomic approval, migration, concurrency, real browser/feed journeys, desktop/mobile
accessibility, and the captured-source pilot. The
[local workspace runbook](../docs/manual-review-local.md) covers startup and use.
Plan 008 remains TODO for its broader deferred scope and must reuse this workspace.

The owner's subsequent Plan 014 direction makes classifier results the default
screen and corrections optional during normal use. It reuses Plan 013's local
workspace, adds immutable prediction/source snapshots and versioned feedback,
and enables bounded local generation with the configured provider. All 98
captured comments have local results, with no processing failures. The
[completion report](reports/014-classifier-results-completion.md) records the
implementation and verification; the
[results runbook](../docs/classifier-results-local.md) covers this workflow.

The subsequent Plan 015 milestone adds bounded automatic local intake under
[ADR 0008](../docs/decisions/0008-local-automatic-feed.md), with browser status,
sync/pause/resume, request limits, and retry recovery. See the
[feed runbook](../docs/daily-feed-local.md) and
[completion report](reports/015-daily-feed-completion.md). Private browsing still
requires no approval, and corrections remain optional feedback.

Plan 016 adds title/summary search and independent persistent bookmarks to the
same workspace. See its [completion report](reports/016-search-bookmarks-completion.md)
for migration preservation, concurrency, pagination, and browser verification.

Plans 009–012 were generated by a technical audit on 2026-08-30
(commit `113b48e`). 010 and 012 are independent quick wins. 011 should land
before the first live holdout run under 009 Step 4. 009 is the critical-path
endgame: it pre-registers the rule that decides between a fresh v3 cycle and
the assist-only endpoint, so the project reaches a terminal state either way.
The audit's default selection (correctness core + crash recovery + hygiene +
endgame) was made in the owner's absence; the owner may substitute or add
plans from the deferred findings below.

## Audit findings deliberately deferred (not planned)

- **Reader-feed pagination** (`packages/db/src/repositories/reader.ts:94-372`):
  `take: limit` applied before publication-eligibility filtering silently
  skips eligible content. M effort, MED risk — characterization tests first.
- **Export outbox batching** (`packages/db/src/repositories/findthatproject-export.ts:201-229, 867-873`):
  3 queries per source in a loop; bulk retract is M serial transactions with
  partial-retract on mid-loop failure. M effort, MED risk.
- **`evaluation-cycle.ts` module split** (1,087 lines, 18 exports, hand-rolled
  validators duplicating zod): M effort, MED risk; existing characterization
  tests mitigate.
- **Shared scripts runtime** (12 drifted copies of the CLI parser across
  `scripts/*.mts`; relative-source imports bypass workspace exports):
  M effort, LOW risk; migrate incrementally.
- **Worker lease-renewal duplicate execution** (`apps/worker/src/index.ts:159-175`):
  needs AbortController plumbing plus idempotent run persistence first.
- **Worker loop test coverage / coverage tooling / `test:all`**: fold into a
  future pass.
- **Cursor HMAC key separation** (`apps/api/src/app.ts:92,103`): defensive
  hardening for a single-user app; optional `CURSOR_SECRET` env var.

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
