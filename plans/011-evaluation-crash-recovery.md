# Plan 011: Make evaluation crash states recoverable (abandon a wedged holdout claim; idempotent annotation-failure recording)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report. When done, update
> this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 113b48e..HEAD -- scripts/evaluate-classifier.mts scripts/compare-annotation-passes.mts packages/application/src/classification/evaluation-cycle.ts`
> On any mismatch with the "Current state" excerpts, STOP.

## Status

- **Priority**: P2 (P1 if a live v3 holdout run is imminent — execute before the first one)
- **Effort**: M
- **Risk**: MED (touches the pre-registration guarantee; mitigation is the narrow precondition set)
- **Depends on**: none (but land before any live holdout run under plans/009)
- **Category**: bug
- **Planned at**: commit `113b48e`, 2026-08-30

## Why this matters

The evaluation lifecycle is deliberately fail-closed, but two of its
terminal-ish states have **no recovery path at all** after an ordinary crash:

1. A holdout run interrupted between the `HOLDOUT_CLAIMED` manifest
   transition and the final report write leaves the cycle permanently
   wedged: reruns are rejected by both the claimed-state check and the
   leftover `.attempt` marker. The existing recovery command
   (`scripts/finalize-evaluation-holdout.mts`) only helps when a *complete
   report was already written*. When it wasn't, the double-annotated corpus
   of that cycle is effectively burned and someone will eventually
   hand-edit the manifest — exactly what the machinery exists to prevent.
2. Recording an annotation failure (`compare-annotation-passes.mts`) writes
   artifacts with exclusive-create (`wx`) before the manifest rename, but
   cleanup only unlinks files *that run* created. A crash mid-sequence
   leaves orphans that make every subsequent rerun fail with `EEXIST` — so
   even the failure cannot be recorded without manual file surgery.

## Current state

- `scripts/evaluate-classifier.mts:734-764` — holdout attempt reservation:
  `.attempt` marker written with `wx` before the first provider request.
- `scripts/evaluate-classifier.mts:766-774` — manifest advanced to
  `HOLDOUT_CLAIMED` (persisted) before rows run.
- `scripts/evaluate-classifier.mts:1446` — marker unlinked only on success.
- `packages/application/src/classification/evaluation-cycle.ts:763-770` —
  `assertEvaluationHoldoutMayOpen` rejects a `HOLDOUT_CLAIMED` cycle.
- `scripts/finalize-evaluation-holdout.mts` (196 lines) — the existing
  recovery script for the *complete-report* case; it revalidates the frozen
  development report field-by-field and terminalizes without provider
  calls. Model the new script's style, arg parsing, and validation posture
  on it.
- `scripts/compare-annotation-passes.mts:190-199` — failure artifacts
  (`evaluation/annotations/failed/<cycle>/annotator-{a,b}.jsonl`, the
  comparison report under `evaluation/reports/`) written one-by-one with
  `wx`; manifest rename at line ~203; cleanup at lines 206-215 unlinks only
  paths created by the current run.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit tests | `npm test` | all pass |
| Evaluation tests | `npm run test:evaluation` | all pass |
| Cycle validation | `npm run evaluation:validate-cycles` | exit 0 |

## Scope

**In scope**:
- `scripts/abandon-evaluation-holdout.mts` (create)
- `scripts/finalize-evaluation-holdout.mts` (only to share helpers if that
  keeps the new script consistent)
- `scripts/compare-annotation-passes.mts`
- `packages/application/src/classification/evaluation-cycle.ts` (one new
  exported transition function, Step 2)
- `package.json` (add the `evaluation:abandon-holdout` alias next to the
  existing `evaluation:finalize-holdout`)
- Tests extending `tests/evaluation/evaluation-cycle.test.ts` and the
  compare-annotations test file.

**Out of scope**:
- `scripts/evaluate-classifier.mts` claim/report logic — untouched.
- Any frozen artifact under `evaluation/` — the new script must never run as
  part of tests against real manifests; tests use temp directories (follow
  the existing test suite's temp-manifest pattern in
  `tests/evaluation/evaluation-cycle.test.ts`).
- Weakening any other gate or validator.

## Git workflow

Branch `advisor/011-crash-recovery`. Commits: one per step, single-line
imperative subjects. No push/PR unless instructed.

## Steps

### Step 1: `abandon-evaluation-holdout.mts`

New script, CLI shape mirroring `finalize-evaluation-holdout.mts`
(`--cycle <id>`). It performs exactly one transition:
`HOLDOUT_CLAIMED → CANDIDATE_SELECTED`, and only when **all** of these hold:

1. The cycle manifest for `<id>` currently says `HOLDOUT_CLAIMED`.
2. No holdout report for that cycle exists under `evaluation/reports/`
   (check every filename pattern the evaluator produces — derive the
   expected name shape from `evaluate-classifier.mts`'s report naming, or
   scan for any file matching `holdout-<cycle>-*`).
3. The stale `.attempt` marker exists (its absence means something else is
   wrong — refuse).
4. The manifest's frozen candidate and development-report fields are intact
   (reuse the existing validation helpers `evaluation-cycle.ts` already
   exports).

On success: atomically rewrite the manifest back to `CANDIDATE_SELECTED`
(same temp-file + rename protocol the other transitions use), **delete the
`.attempt` marker**, and print a body-free audit line (cycle id, old/new
state, marker path). The manifest rewrite should append to whatever
audit/notes field the lifecycle already records, stating the claim was
abandoned with zero provider calls made and no report written — if no such
field exists, add a `claimAbandonedAt`-style optional field consistent with
the existing manifest schema and update
`evaluation/annotation-comparison`-style schemas only if validation demands.

On any precondition failure: exit non-zero with a precise message, change
nothing.

**Verify**: `npm run typecheck` clean; manual dry run against a fabricated
`HOLDOUT_CLAIMED` manifest in a temp dir (see the test below) transitions
correctly and refuses when a report file is planted.

### Step 2: Export the transition from `evaluation-cycle.ts`

Add `abandonEvaluationHoldoutClaim(...)` to
`packages/application/src/classification/evaluation-cycle.ts` implementing
the state-machine half (precondition checks + atomic manifest rewrite),
keeping the file's existing validator/transition style. The script is a thin
CLI wrapper. Extend the state-machine tests in
`tests/evaluation/evaluation-cycle.test.ts`:

- `HOLDOUT_CLAIMED → CANDIDATE_SELECTED` succeeds with preconditions met.
- Refused when a report file exists, when the marker is absent, when the
  state is anything else (`OPENED_*`, `ANNOTATED`, ...).
- After abandonment, `assertEvaluationHoldoutMayOpen` accepts the cycle
  again (a new claim attempt is possible) — verify this is true; if the
  attempt-marker deletion is also required for the evaluator to accept a
  rerun, assert both.

**Verify**: `npm run test:evaluation` passes with the new cases.

### Step 3: Idempotent annotation-failure recording

In `scripts/compare-annotation-passes.mts`, replace the bare `wx` writes in
the failure path (lines ~190-199) with a helper:

```
writeExclusiveOrVerify(path, bytes, expectedDigest):
  - try wx write (current behavior)
  - on EEXIST: hash the existing file; if it equals the digest this run
    computed, treat as already-written and continue; otherwise unlink and
    rewrite once
```

Keep the manifest rename strictly last (unchanged). Extend the existing
compare-annotations tests (locate via
`grep -rn "compare-annotation" tests/`) with: a crashed-run simulation —
pre-plant the annotator pass files with matching digests, run the failure
path, expect success and manifest `ANNOTATION_FAILED`; and a mismatched
pre-planted file case expects the rewrite.

**Verify**: `npm test` and `npm run test:evaluation` pass.

## Test plan

Covered in-steps. Patterns: temp-dir manifest fixtures from
`tests/evaluation/evaluation-cycle.test.ts`; script-level tests follow the
existing compare-annotations test structure.

## Done criteria

- [ ] `npm run evaluation:abandon-holdout -- --cycle <id>` exists and exits
      non-zero on a healthy/non-claimed cycle without modifying anything.
- [ ] The transition is exported from `evaluation-cycle.ts` and covered by
      state-machine tests (success + 3 refusal cases).
- [ ] `compare-annotation-passes.mts` failure path succeeds over
      matching-digest pre-existing artifacts (test proves it).
- [ ] `npm run typecheck && npm test && npm run test:evaluation && npm run evaluation:validate-cycles` exit 0.
- [ ] No file outside the in-scope list modified.
- [ ] `plans/README.md` row updated.

## STOP conditions

- Implementing the precondition checks requires changing any frozen
  artifact or another gate.
- The manifest schema has no place to record an abandonment and adding one
  would invalidate existing manifests (version bump required) — report
  instead of bumping.
- `assertEvaluationHoldoutMayOpen` has additional coupled invariants that
  make claim-abandonment unsound.

## Maintenance notes

- This script deliberately narrows fail-closed behavior; reviewers should
  confirm the four preconditions remain conjunctive — any loosening turns
  it into a holdout-rerun tool, which the pre-registration regime forbids.
- Interacts with plans/009 Step 4: run this plan **before** the first live
  v3 holdout so an interrupted run is recoverable.
- Deferred: general lease/worker crash recovery (audit finding on
  `apps/worker/src/index.ts:159-175`) is a separate concern, not covered
  here.
