# Plan 010: Fix four correctness defects in the classification core (dead worker wiring, locale-dependent split sort, untested κ math, deflated latency gate)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report. When done, update
> this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 113b48e..HEAD -- apps/worker/src/index.ts packages/application/src/classification/evaluation-cycle.ts packages/application/src/classification/annotation-packet.ts scripts/evaluate-classifier.mts`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (Step 1 enables a real-spend path; Steps 2–4 are LOW risk)
- **Depends on**: none
- **Category**: bug | tests
- **Planned at**: commit `113b48e`, 2026-08-30

## Why this matters

Four independent defects, each cheap to fix:

1. **The worker can never classify.** `apps/worker/src/index.ts:122` passes
   `null` unconditionally as the classifier, so every `CLASSIFY_COMMENT` job
   terminates with `CLASSIFIER_DISABLED` — even when
   `CLASSIFIER_ENABLED=true` and the validated provider env vars are set.
   The env contract (`packages/config/src/env.ts:94-98`, plus the
   `superRefine` requiring provider/token/model when enabled) promises
   behavior the worker does not have.
2. **The "deterministic" holdout split ordering is locale-dependent.**
   `evaluation-cycle.ts:294` sorts SHA-256 hex with `localeCompare`. If any
   machine's ICU collation orders the hex strings differently, the recomputed
   split no longer matches frozen manifests and `validateManifest` rejects
   every existing cycle.
3. **Cohen's κ — the gate that sealed cycle v2 — has no non-trivial test.**
   Existing tests only assert κ = 1 and κ < 0.75; a regression in the
   expected-agreement summation would pass the suite.
4. **Failed runs count as 0 ms latency**, deflating the p50/p95 acceptance
   gate so a degenerate run can pass the latency criterion.

## Current state

- `apps/worker/src/index.ts:120-126`:
  ```ts
  const classify = createClassifyJobHandler(
    null,
    classifications,
    hasher,
    reviews,
    config.WORKER_MAX_ATTEMPTS,
    pipelineMetrics,
  );
  ```
  `apps/worker/src/jobs/classify.ts:29-34` throws
  `new WorkerJobError("CLASSIFIER_DISABLED", false)` when the classifier is
  null. `packages/adapters/src/classifier/openai.ts:199` exports
  `OpenAiClassifier implements ClassifierPort` with options at
  `openai.ts:26` (see `scripts/evaluate-classifier.mts:596-608` for a live
  construction example: it reads `CLASSIFIER_PROVIDER` /
  `CLASSIFIER_API_TOKEN` / `CLASSIFIER_MODEL` / reasoning effort /
  `CLASSIFIER_REQUEST_TIMEOUT_MS` from the loaded env and validates
  `CLASSIFIER_PROVIDER === "openai"`).
- `packages/application/src/classification/evaluation-cycle.ts:289-296`:
  ```ts
  .sort((left, right) => {
    const leftHash = sha256Text(`${salt}:${left}`);
    const rightHash = sha256Text(`${salt}:${right}`);
    return leftHash.localeCompare(rightHash) || left - right;
  })
  ```
  Algorithm name `SHA256_SORT_V1` is recorded in manifests.
- `packages/application/src/classification/annotation-packet.ts:859-880` —
  `cohensKappa` (hand-rolled). Tests at
  `tests/unit/classification/annotation-packet.test.ts:237-296` assert only
  κ = 1 and κ < 0.75.
- `scripts/evaluate-classifier.mts:998-1001`:
  ```ts
  const latencies = repository.runInputs
    .map((run) => run.latencyMs ?? 0)
    .sort((left, right) => left - right);
  ```
  Failed runs record `latencyMs: null`
  (`packages/application/src/classification/classify.ts:177`). The p95 gate
  consumes this array around line 1301.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Lint/format | `npm run lint && npm run format:check` | exit 0 |
| Unit tests | `npm test` | all pass |
| Evaluation tests | `npm run test:evaluation` | all pass |
| Cycle validation | `npm run evaluation:validate-cycles` | exit 0, v1/v2 terminal states unchanged |

## Scope

**In scope**:
- `apps/worker/src/index.ts`
- `apps/worker/src/classifier.ts` (create — see Step 1)
- `packages/application/src/classification/evaluation-cycle.ts`
- `scripts/evaluate-classifier.mts`
- Tests: `tests/unit/worker/*` (create dir if absent),
  `tests/unit/classification/evaluation-cycle.test.ts`,
  `tests/unit/classification/annotation-packet.test.ts`,
  `tests/evaluation/classification-gates.test.ts` (or the file that covers
  report aggregation — extend the existing suite).

**Out of scope**:
- `packages/config/src/env.ts` — the env contract is correct; the worker is
  what's wrong.
- `apps/worker/src/jobs/classify.ts` — the null-guard there stays as the
  fail-closed default.
- Any evaluation artifact under `evaluation/` — Steps 2 and 4 must not change
  frozen digests or manifests.
- `docs/decisions/0005-classifier-provider.md` — promotion policy unchanged;
  wiring the adapter ≠ enabling it (default stays `CLASSIFIER_ENABLED=false`).

## Git workflow

Branch `advisor/010-correctness-core`. One commit per step, imperative
single-line subjects (repo style, e.g. `Wire worker classifier behind enable flag`). No push/PR unless instructed.

## Steps

### Step 1: Wire the OpenAI classifier into the worker behind `CLASSIFIER_ENABLED`

Create `apps/worker/src/classifier.ts` exporting
`createWorkerClassifier(config): ClassifierPort | null`:

- Return `null` unless `config.CLASSIFIER_ENABLED === true`.
- Assert `config.CLASSIFIER_PROVIDER === "openai"` and that
  `CLASSIFIER_API_TOKEN` / `CLASSIFIER_MODEL` are present (the config schema
  already enforces this when enabled; throw a startup error, not a per-job
  one, if drift ever occurs).
- Construct `new OpenAiClassifier({...})` mirroring
  `scripts/evaluate-classifier.mts:596-608` (token, model, reasoning effort
  from `CLASSIFIER_REASONING_EFFORT`, timeout from
  `CLASSIFIER_REQUEST_TIMEOUT_MS`).

In `apps/worker/src/index.ts`, replace the literal `null` at line 122 with
`createWorkerClassifier(config)`. Import from `@hn-knowledge/adapters` if the
worker already imports workspace packages; otherwise match whatever import
style `index.ts` uses for other adapter packages.

**Caution — real spend:** with `CLASSIFIER_ENABLED=true`, each ingested
comment triggers a paid provider call. Default remains false; note this in
the commit message. Do not enable it in any `.env` you create during testing.

Unit test (new file, model after `tests/unit/ingestion/mtcute-session.test.ts`
for structure): `createWorkerClassifier` returns null when disabled; returns
an `OpenAiClassifier` when enabled with valid config (assert `instanceof`);
throws on provider mismatch. Add a composition test asserting
`createClassifyJobHandler(createWorkerClassifier(enabledConfig), ...)` does
not throw `CLASSIFIER_DISABLED` for a valid payload when given a stub
classifier port (use `packages/adapters/src/classifier/fixture.ts`
  `FixtureClassifier` as the stub via injection if direct construction is
awkward — prefer testing the factory's wiring over a full job run).

**Verify**: `npm run typecheck && npm test` pass, new tests included.

### Step 2: Replace `localeCompare` with a codepoint comparator

In `evaluation-cycle.ts:294` change
`return leftHash.localeCompare(rightHash) || left - right;` to
`return (leftHash < rightHash ? -1 : leftHash > rightHash ? 1 : 0) || left - right;`
(operator precedence of `||` with 0 works the same as before — the numeric
tiebreak only applies on hash equality, which cannot happen for distinct IDs
but is retained for safety).

Do **not** change the algorithm name `SHA256_SORT_V1` or any digest.

Then run `npm run evaluation:validate-cycles` — this is the critical check
that the new comparator reproduces every frozen manifest's split exactly.
If it fails, the hex ordering under some past environment differed; STOP and
report rather than "fixing" manifests.

Add a unit test in `tests/unit/classification/evaluation-cycle.test.ts`:
for a fixed comment-ID list and salt, the computed holdout set equals a
hard-coded fixture array (generate it once with the new comparator and paste
the literal), and the comparator is stable (sorting twice yields the same
array).

**Verify**: `npm run evaluation:validate-cycles` exits 0 unchanged;
`npm run test:evaluation` passes.

### Step 3: Table-driven Cohen's κ tests

Add to `tests/unit/classification/annotation-packet.test.ts` cases with
hand-computed values (compute by hand, not by running the implementation):

- po = 0.8, pe = 0.5 → κ = 0.6 (e.g. 10 items, 8 agree, classes distributed
  so annotator marginals give pe = 0.5).
- Perfect agreement with non-uniform marginals → κ = 1.
- pe = 1 with po < 1 → the documented branch returns 0 (verify the branch at
  `annotation-packet.ts:~875` actually does; if it returns something else,
  fix the test expectation to the documented behavior and flag it in the
  report).
- Two identical sequences of length ≥ 30 across 4 classes → κ = 1 (guards
  the summation at realistic size).

Call `cohensKappa` via whatever export path the existing tests use (it is
module-private; the existing tests exercise it through the comparison
function — follow that pattern, exporting `cohensKappa` for tests is
acceptable if needed and is the only signature change allowed).

**Verify**: `npm test -- annotation-packet` passes with the new cases.

### Step 4: Latency percentiles over successful runs only

In `scripts/evaluate-classifier.mts:998-1001`:

```ts
const latencies = repository.runInputs
  .filter((run) => run.latencyMs !== null)
  .map((run) => run.latencyMs as number)
  .sort((left, right) => left - right);
```

Guard the `percentile` helper for an empty array (return `null` and make the
p50/p95 report fields nullable, or 0 with an explicit `latencySampleCount`
field added to the report — prefer adding `latencySampleCount`; it makes the
deflation visible forever). Update the report fixtures only if validation
requires the new field; if fixtures are validated against a schema version
bump, add the field as optional to avoid a version churn. Find the p95 gate
(~line 1301) and confirm it now compares against the filtered percentile.

Extend the existing evaluation test suite with one case: a run mix of
successes and null-latency failures produces `latencySampleCount` equal to
the success count and p95 computed from successes only.

**Verify**: `npm run test:evaluation && npm run evaluation:validate-cycles`
pass.

## Test plan

Covered per step above. Structural patterns: worker factory tests modeled on
`tests/unit/ingestion/mtcute-session.test.ts`; κ tests extend
`tests/unit/classification/annotation-packet.test.ts`; report-aggregation
tests extend `tests/evaluation/classification-gates.test.ts`.

## Done criteria

- [ ] `grep -n "createClassifyJobHandler(" apps/worker/src/index.ts` shows a
      non-literal-`null` first argument sourced from `createWorkerClassifier`.
- [ ] `grep -n "localeCompare" packages/application/src/classification/evaluation-cycle.ts` returns nothing.
- [ ] `npm run typecheck && npm run lint && npm test && npm run test:evaluation && npm run evaluation:validate-cycles` all exit 0.
- [ ] New tests exist for: classifier factory wiring, split-order stability, three non-trivial κ cases, latency filtering.
- [ ] No file outside the in-scope list modified (`git status`).
- [ ] `plans/README.md` row updated.

## STOP conditions

- `evaluation:validate-cycles` fails after Step 2 — a past environment
  produced a different ordering; do not touch manifests.
- Wiring the classifier requires touching `packages/config` or promotion
  policy files.
- The κ `pe = 1` branch behaves differently from the documented "returns 0".
- Report schema change in Step 4 escalates beyond adding an optional field.

## Maintenance notes

- Step 1 is the mechanism plans/009's assist-only endpoint would use if
  review-assist is ever wanted in production; review the canary note there.
- Any future change to `SHA256_SORT_V1` semantics invalidates every frozen
  cycle — the comparator is now load-bearing; reviewers should reject any
  edit to that sort.
- Deferred from audit: lease-renewal duplicate-execution risk
  (`apps/worker/src/index.ts:159-175`) — needs AbortController plumbing and
  idempotent run persistence first; separate follow-up.
