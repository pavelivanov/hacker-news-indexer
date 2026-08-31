# Plan 012: Hygiene batch — dead fixtures, doc/schema drift, root strays, @types/node pin, AGENTS.md

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report. When done, update
> this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 113b48e..HEAD -- evaluation/ evaluation/README.md package.json docs/annotation-guide.md`
> On any mismatch with the "Current state" facts, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt | docs | dx
- **Planned at**: commit `113b48e`, 2026-08-30

## Why this matters

Small, independent cleanups that each remove an active cost: superseded
fixtures obscure which evaluation artifacts are load-bearing; the annotator
README points at the wrong schema version; two untracked annotation files
sit at the repo root one rename away from being committed; `@types/node` is
two majors ahead of the pinned Node 24 engine so typecheck can bless
Node-26-only APIs; and a repo built around agent-executed plans has no
`AGENTS.md`, forcing every executor to rediscover conventions.

## Current state

- `evaluation/reports/` contains `benchmark-fixture-v1..v5.json` and
  `shadow-fixture-v1..v5.json`. Referenced anywhere: **v5** (current) and
  **v3** (one negative test at `tests/evaluation/classification-gates.test.ts:155`).
  v1, v2, v4 of both families are referenced by zero files.
- `evaluation/annotation-schema.json` is the superseded v1 gold-row schema;
  the active one is `evaluation/annotation-schema-v2.json` (used by
  `scripts/prepare-annotation-packets.mts:131` and
  `tests/unit/classification/annotation-adjudication.test.ts:142`). Yet
  `evaluation/README.md:5` says gold rows match `annotation-schema.json`.
- Untracked at repo root: `annotator-a-v2.jsonl` (sha256
  `4e95fe4d…da8c`) and `annotator-b-v2.jsonl` (sha256 `fa4702aa…7a095`).
  These digests **exactly match** the `annotatorA`/`annotatorB` digests
  pinned in `evaluation/cycles/v2.json` (frozen copies live at
  `evaluation/annotations/failed/v2/annotator-{a,b}.jsonl`). They are
  confirmed duplicates of sealed evidence.
- Root `package.json`: `"engines": { "node": ">=24 <25" }`; devDependencies
  include `"@types/node": "26.2.0"`. CI pins Node 24.19.0
  (`.github/workflows/ci.yml`).
- No `AGENTS.md` / `CLAUDE.md` exists at the repo root.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Re-check references | `grep -rn "fixture-v1\|fixture-v2\|fixture-v4" --include='*.{ts,mts,json,md}' .` (exclude node_modules) | only historical/self references |
| Typecheck | `npm run typecheck` | exit 0 |
| Full unit | `npm test` | all pass |
| Evaluation | `npm run test:evaluation` and `npm run evaluation:validate-cycles` | exit 0, cycles unchanged |
| Format/lint | `npm run format:check && npm run lint` | exit 0 |

## Scope

**In scope**:
- Delete: `evaluation/reports/benchmark-fixture-v1.json`,
  `benchmark-fixture-v2.json`, `benchmark-fixture-v4.json`,
  `shadow-fixture-v1.json`, `shadow-fixture-v2.json`,
  `shadow-fixture-v4.json`, `evaluation/annotation-schema.json`.
- Delete repo-root `annotator-a-v2.jsonl`, `annotator-b-v2.jsonl`.
- Edit: `evaluation/README.md`, root `package.json` (+ `npm install` to
  update the lockfile), new `AGENTS.md`.
- Update `plans/README.md` status row.

**Out of scope** (do NOT delete or modify):
- All live/historical non-fixture reports under `evaluation/reports/`
  (benchmark-openai-*, holdout-openai-*, export-audit-*, review-load-*,
  subject-dedup-*, annotation-comparison-v2.json) — sealed audit trail.
- `benchmark-fixture-v3.json` / `shadow-fixture-v3.json` — still referenced
  by `tests/evaluation/classification-gates.test.ts:155`.
- `evaluation/annotations/**`, `evaluation/cycles/**`, `evaluation/captures/**`.
- Any source under `apps/`, `packages/`, `scripts/`.

## Git workflow

Branch `advisor/012-hygiene`. One commit per logical unit. No push/PR unless
instructed.

## Steps

### Step 1: Re-verify the fixture references, then delete

Run the grep from the commands table for each candidate filename. Expected:
zero references outside the fixture files themselves (v3 is the known
exception — kept). If any v1/v2/v4 fixture turns out to be referenced,
keep that file and note it in the report.

Delete the six fixture files and `evaluation/annotation-schema.json`.

**Verify**: `grep -rn "annotation-schema.json" --include='*.md' evaluation/ docs/ plans/` — remaining hits are the ones Step 2 fixes; `npm run test:evaluation` passes (v3 fixtures still present).

### Step 2: Fix `evaluation/README.md` schema references

- Line 5: change "matching `annotation-schema.json`" to "matching
  `evaluation/annotation-schema-v2.json`".
- Sweep the file for other v1-era claims: any mention of the gold-row
  schema, fixture naming, or report version that contradicts
  `CLASSIFICATION_EVALUATION_REPORT_VERSION = 5`
  (`packages/application/src/classification/evaluation-cycle.ts:8`) and the
  v5 fixture names. Fix only factual drift; do not restructure the doc.
- Add one line to the annotation-output section: annotator pass files must
  be stored under `evaluation/annotations/<cycle>/` (or `failed/<cycle>/`),
  never at the repository root.

**Verify**: `npm run format:check` passes; a manual read of lines 1–40 shows no v1 schema reference.

### Step 3: Remove the root strays

The digest comparison is already done (see Current state — digests match the
v2 manifest exactly). Re-run it yourself to confirm nothing changed:

```bash
shasum -a 256 annotator-a-v2.jsonl annotator-b-v2.jsonl
# must equal the annotatorA/annotatorB sha256 values in evaluation/cycles/v2.json
```

Then `rm annotator-a-v2.jsonl annotator-b-v2.jsonl`. If either digest no
longer matches, STOP — a diverged copy is exactly the wrong-file hazard this
step exists to remove, and it needs human review instead.

**Verify**: `git status --porcelain` shows no untracked annotation files;
`npm run evaluation:validate-cycles` still exit 0.

### Step 4: Pin `@types/node` to the Node 24 line

In root `package.json` devDependencies, change `"@types/node": "26.2.0"` to
the latest 24.x published version (exact-pin style, matching the repo's
convention — check `npm view @types/node versions --json | tail` and pick
the highest `24.x`). Run `npm install` to update the lockfile. Fix any
typecheck errors that surface — each one is a latent Node-26-only API usage
in Node-24 runtime code; if a fix is non-trivial (more than an equivalent
API swap), note it and STOP for that item rather than improvising.

**Verify**: `npm run typecheck && npm run lint && npm test` exit 0;
`grep -n '"@types/node"' package.json` shows a `24.` version.

### Step 5: Add `AGENTS.md`

Create a concise (≤120 lines) `AGENTS.md` at the repo root covering:

1. **Workspace map**: `apps/api` (Hono HTTP), `apps/worker` (Postgres-backed
   job queue), `packages/{domain,application,ports,adapters,contracts,config,db}`,
   `scripts/` (npm-alias-routed ops commands), `evaluation/` (frozen
   artifacts), `plans/` (numbered execution plans + status table).
2. **Routing rule**: run ops commands via the npm aliases in `package.json`
   (`npm run evaluation:validate-cycles`, etc.), never `tsx scripts/…`
   by hand with custom paths.
3. **The one hard rule**: never hand-create, edit, or regenerate anything
   under `evaluation/cycles/`, `evaluation/reports/` (non-fixture),
   `evaluation/annotations/`, or `evaluation/captures/` — they are
   digest-pinned sealed evidence; changes go through the scripts that own
   them. Annotator output never lands at the repo root.
4. **Test tiers** and when each is required: `npm test` (unit, always),
   `npm run test:integration` (DB-touching changes; needs
   `docker compose up -d postgres` + `npm run db:test:wait` +
   `db:migrate:deploy`), `npm run test:contract`, `npm run test:evaluation`
   (anything under `packages/application/src/classification/` or
   `evaluation/`).
5. **Global verification gate**: quote the block from `plans/README.md`
   ("Global verification gate") by reference, do not duplicate it.
6. **Pointers**: `docs/decisions/` ADRs (esp. 0005),
   `evaluation/README.md`, `docs/annotation-guide.md`, `plans/README.md`
   status table — and the instruction to read the relevant plan fully
   before executing it and honor its STOP conditions.

**Verify**: `npm run format:check` passes (if AGENTS.md is in the prettier
glob; if not, still keep it clean); `git status` shows only the new file.

## Test plan

No new tests — deletions and docs. The regression net is the full command
table above; the critical invariant is that `npm run
evaluation:validate-cycles` and `npm run test:evaluation` stay green
throughout (they prove the deleted fixtures were truly dead and the frozen
artifacts untouched).

## Done criteria

- [ ] The six v1/v2/v4 fixture files and `evaluation/annotation-schema.json` no longer exist; `grep -rn "benchmark-fixture-v4"` (etc.) returns nothing.
- [ ] `evaluation/README.md` references `annotation-schema-v2.json`; no root-level annotation strays remain (`git status --porcelain` clean of them).
- [ ] `package.json` `@types/node` is `24.x`; lockfile updated; typecheck green.
- [ ] `AGENTS.md` exists with the six sections.
- [ ] `npm run typecheck && npm test && npm run test:evaluation && npm run evaluation:validate-cycles && npm run format:check && npm run lint` all exit 0.
- [ ] `plans/README.md` row updated.

## STOP conditions

- Any deleted fixture turns out to be referenced (keep it, report).
- A root stray's digest does not match the v2 manifest.
- Downgrading `@types/node` surfaces a non-trivial API incompatibility.
- Anything under `evaluation/cycles|annotations|captures` would need to
  change.

## Maintenance notes

- The `AGENTS.md` test-tier section and the `plans/README.md` global gate
  must be updated in lockstep if the gate ever changes — note this in
  AGENTS.md itself ("update both or neither").
- Deferred from audit (not in this plan): the ~30-script shared runtime
  (duplicated arg parser/path guards), the `evaluation-cycle.ts` module
  split, reader-feed pagination and export batching — see
  `plans/README.md` deferred-findings note.
