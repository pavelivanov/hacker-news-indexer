# Plan 009: Resolve the classifier endgame via rubric calibration with a pre-registered assist-only fallback

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 113b48e..HEAD -- docs/annotation-guide.md plans/003r-recover-classifier-generalization.md evaluation/README.md evaluation/cycles/`
> If any of those changed since this plan was written, compare the
> "Current state" facts below against the live files before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH (decides the project's terminal classifier posture; no code risk)
- **Depends on**: none
- **Category**: direction / process
- **Planned at**: commit `113b48e`, 2026-08-30

## Why this matters

Evaluation cycle v1 failed its model holdout. Cycle v2 failed *before any model
ran*: the two independent annotators agreed at primary-class Cohen's κ = 0.5713
and materiality κ = 0.5980 against a required 0.75, so v2 was sealed terminal
`ANNOTATION_FAILED`. The prescribed recovery (calibrate on a separate corpus,
then a fresh v3 cycle) does not address *why* agreement failed, so a v3 attempt
under the current instrument is likely to fail the same gate and burn another
capture + 2×90 annotations + adjudication effort.

This plan gives the rigorous path one genuine last chance and defines, in
advance, the exit ramp if it fails — so the project reaches a terminal state
either way instead of looping.

Two facts drive the approach:

1. The **binary materiality question itself** was disputed (κ 0.598), which
   means the boundary definitions in `docs/annotation-guide.md` are too thin,
   not that the annotators were careless. The guide gives one sentence each to
   distinctions like FEATURE vs TOOL vs RESOURCE.
2. The product is a **single-user private tool where every model decision is
   mandatory-review** and stays inactive until promotion
   (`plans/README.md` locked decisions; `docs/decisions/0005-classifier-provider.md`).
   Full human-human taxonomy agreement may be a stricter bar than the product
   needs: an "assist-only" endpoint (classifier suggestions + mandatory human
   review, no automated quality claim) is a legitimate terminal state.

## Current state

- `docs/annotation-guide.md` — 97 lines. Sections: Primary decisions (4
  classes, one line each), Evidence origins, Subject types (10 types, one line
  each), Expert-note types (8 types, one line each), Review reasons,
  Fresh-cycle independent passes (rules incl. the κ≥0.75 gate and the
  calibration-on-separate-corpus requirement). It contains **zero worked
  examples**.
- `evaluation/cycles/v2.json` — terminal `ANNOTATION_FAILED`, pins the failed
  pass digests. `evaluation/reports/annotation-comparison-v2.json` — the
  body-free comparison report with the κ values above.
- `packages/application/src/classification/annotation-packet.ts:10` —
  `export const MINIMUM_ANNOTATION_COHENS_KAPPA = 0.75;` enforced at lines
  944-945. Do not change this constant.
- Annotation workflow commands (from `evaluation/README.md`):
  `npm run evaluation:prepare-annotations`, `evaluation:validate-annotation`,
  `evaluation:compare-annotations`, `evaluation:finalize-annotations`,
  `evaluation:capture-source`, `evaluation:build-source`,
  `evaluation:prepare-cycle`, `evaluation:validate-cycles`.
- Cycle numbering: v1 terminal `OPENED_FAILED`, v2 terminal
  `ANNOTATION_FAILED`. `prepare-cycle` rejects skipped numbers, so the next
  cycle is **v3**.
- Guardrail that constrains this plan (from `docs/annotation-guide.md`
  "Fresh-cycle independent passes" and `plans/003r`): row-level disagreements
  from failed cycles must **not** be shown to annotators, reconciled, or used
  for prompt/rubric work. Calibration must use a separate corpus that is
  excluded from every evaluation cycle. This plan honors that rule.

## The pre-registered decision rule (write this down first)

Before any calibration corpus is labeled, add to `docs/annotation-guide.md` a
short "Endgame decision rule" section stating verbatim-intent:

> If the second calibration batch (Step 3 below) still fails to reach κ ≥ 0.75
> on either primary class or material relevance, the project adopts the
> assist-only endpoint: `CLASSIFIER_ENABLED` remains false for automatic
> decisions, all classification output is restricted to mandatory human review
> (the existing behavior of `decision-router.v1` + the unpromoted-provider
> review gate), Plan 003R is closed as satisfied-at-assist-level, and Plan 007
> production deployment proceeds with the review-only classifier. No further
> annotation cycles are opened.

This rule is the point of the plan: the fallback is decided *before* seeing
calibration results, so the exit cannot be rationalized away.

## Scope

**In scope** (the only files you should modify or create):

- `docs/annotation-guide.md` — rewrite/extend per Steps 1–2.
- `docs/decisions/0006-classifier-endgame.md` — new ADR recording the
  decision rule and, when known, the terminal outcome (see Step 5).
- `plans/README.md` and `plans/003r-recover-classifier-generalization.md` —
  status updates only (Step 5).
- New calibration corpus directories outside the evaluation cycle namespace
  (e.g. `evaluation/calibration/v1/`) containing capture metadata and pass
  files — these are **excluded** corpora and must never be referenced by a
  cycle manifest.

**Out of scope** (do NOT touch):

- `evaluation/cycles/*.json`, `evaluation/reports/annotation-comparison-v2.json`,
  `evaluation/annotations/failed/**` — sealed terminal evidence.
- `packages/application/src/classification/*` — the κ constant and comparison
  tooling stay exactly as they are.
- Any prompt, schema, threshold, or router change derived from v1 holdout rows
  or v2 disagreement rows. Both remain forbidden inputs.
- The root-level `annotator-a-v2.jsonl` / `annotator-b-v2.jsonl` strays —
  those are handled by plans/012, not here.

## Git workflow

- Branch: `advisor/009-classifier-endgame`. Commit style: match repo history
  (single-line imperative subjects, e.g. `Document classifier endgame rule`).
  Do not push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the endgame decision rule

Append the pre-registered rule (quoted above) as a new section
"## Endgame decision rule" in `docs/annotation-guide.md`, dated. Commit it
alone so the rule is provably prior to any calibration result.

**Verify**: `git log --oneline -1` shows the commit; `grep -n "Endgame decision rule" docs/annotation-guide.md` finds the section.

### Step 2: Rewrite the annotation guide with worked examples

The current guide's per-class definitions get expanded with worked examples.
Constraints on examples: they must be **newly written paraphrases**, not
quotations of v1/v2 corpus rows (quoting real cycle rows would leak evaluation
data into the rubric). For each of the four primary decisions, add:

- 2 positive examples (one clearly in-class, one borderline-but-in with the
  deciding reason stated),
- 1 near-miss example that belongs to the neighboring class, with the deciding
  reason stated.

Do the same for the `MATERIAL` vs `NOT_MATERIAL` boundary specifically — it
is the weaker gate (κ 0.598) and gets the most detail: at minimum, explicit
rules for (a) jokes that embed a real tool mention, (b) first-hand war
stories with no generalizable content, (c) news links with one-line
commentary, (d) meta-commentary about HN itself.

Also add a short priority ordering when classes seem to overlap
(e.g. "if a comment both names a tool and explains a mechanism, decide by its
principal retained value: name+fact → DISCOVERY; durable explanation →
EXPERT_NOTE") and one fully worked end-to-end row (fabricated comment text →
materiality → class → subject type → note type → evidence spans).

**Verify**: `npm run format:check` passes; a reviewer (the operator) confirms
no example is a verbatim corpus row: `grep -riF "<distinctive phrase from each example>" evaluation/` returns no matches for spot-checked phrases.

### Step 3: Run two calibration batches on an excluded corpus

Calibration uses the same blind dual-pass mechanics as a cycle but on a corpus
that is **not** a cycle and never becomes one:

1. Capture a small fresh window (30–40 comments is enough for calibration) per
   the `evaluation:capture-source` / `evaluation:build-source` commands, but
   store the artifacts under `evaluation/calibration/v1/` and do **not** run
   `evaluation:prepare-cycle` (that command is what creates a numbered cycle;
   skipping it keeps this corpus excluded). Note in
   `evaluation/calibration/v1/README.md` that these rows can never join a
   later cycle — pick the window so a future v3 capture starts after it.
2. Both annotators label independently using the rewritten guide
   (schema `evaluation/annotation-pass-schema-v2.json`, annotator IDs A and B).
3. Between the two batches — and only here — annotators may discuss the
   calibration rows and propose guide clarifications. This is the calibration
   feedback loop the sealed-cycle process forbids; it is legal precisely
   because this corpus is excluded.
4. Run a **second** batch (another 30–40 fresh rows under
   `evaluation/calibration/v2/`) with no discussion between passes, using the
   guide as amended. Compute κ with the same formula the pipeline uses
   (`packages/application/src/classification/annotation-packet.ts` exports the
   comparison through the compare script; for calibration you may compute κ
   with `npm run evaluation:compare-annotations` only if it accepts
   non-cycle input — if it hard-requires a cycle manifest, write the two
   passes into a tiny throwaway harness that imports `cohensKappa` logic by
   replicating its formula; do NOT modify the pipeline to accommodate
   calibration).

**Decision point (apply the pre-registered rule):**

- If batch-2 κ ≥ 0.75 on both axes → proceed to a fresh v3 cycle exactly per
  `evaluation/README.md` "Starting a fresh evaluation cycle", annotating with
  the rewritten guide.
- If batch-2 κ < 0.75 on either axis → adopt the assist-only endpoint. Write
  ADR `docs/decisions/0006-classifier-endgame.md` recording the calibration
  numbers, the terminal decision, and that `CLASSIFIER_ENABLED` stays false
  for automatic decisions while Plan 007 proceeds with the review-only
  pipeline. Close 003R.

**Verify**: `npm run evaluation:validate-cycles` still passes with all cycles
terminal and no new cycle created by calibration. The calibration κ numbers
and the decision taken are recorded in the ADR.

### Step 4: (Only on the v3 path) execute the fresh cycle

Follow `evaluation/README.md` verbatim: capture a later non-overlapping window
(after the calibration windows), `prepare-cycle` for v3, dual-pass annotate
with the rewritten guide, compare, adjudicate if gates pass, then the
hypothesis-pinned development run and the one-time holdout. Every existing
guardrail applies unchanged.

**Verify**: `npm run evaluation:validate-cycles` reports v3 progress states
without ever regressing v1/v2 terminal states.

### Step 5: Record the terminal outcome

Whichever endpoint is reached, update:

- `docs/decisions/0006-classifier-endgame.md` — final state, evidence links.
- `plans/README.md` — 003R row → DONE (assist-only) or its final cycle state.
- `plans/003r-recover-classifier-generalization.md` — status paragraph.

**Verify**: `npm run evaluation:validate-cycles` passes; `git status` clean
of unintended evaluation-artifact changes.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Validate cycles | `npm run evaluation:validate-cycles` | exit 0, v1 OPENED_FAILED, v2 ANNOTATION_FAILED unchanged |
| Format | `npm run format:check` | exit 0 |

## Test plan

No unit tests — this plan changes docs and process artifacts only. The
machine-checkable guarantees are the `evaluation:validate-cycles` runs above
and the grep checks in Steps 1–2.

## Done criteria

- [ ] `docs/annotation-guide.md` contains the pre-registered endgame rule
      (committed before any calibration result existed).
- [ ] The guide contains worked examples for all four primary decisions and
      the materiality boundary, with no verbatim corpus rows.
- [ ] Two calibration batches exist under `evaluation/calibration/`, excluded
      from all cycles; batch-2 κ is recorded.
- [ ] `docs/decisions/0006-classifier-endgame.md` records the terminal
      decision produced by the pre-registered rule.
- [ ] `npm run evaluation:validate-cycles` passes; v1/v2 terminal states
      untouched; no new cycle was created by calibration.
- [ ] `plans/README.md` 003R row updated to the terminal state.

## STOP conditions

Stop and report back (do not improvise) if:

- Any v1/v2 sealed artifact would need to change to proceed.
- You find yourself wanting to show v2 disagreement rows to the annotators —
  that is forbidden; the calibration corpus is the only discussion surface.
- `evaluation:compare-annotations` cannot be pointed at calibration data and
  writing a side harness would require modifying pipeline source — report
  instead of modifying.
- The operator is unavailable to be annotator/adjudicator and no second
  annotator exists — the assist-only endpoint can be adopted by the
  pre-registered rule, but flag it for explicit owner sign-off first.

## Maintenance notes

- If the assist-only endpoint is adopted, `CLASSIFIER_ENABLED` wiring
  (plans/010 Step 1) becomes the mechanism by which review-assist could later
  run in production — keep the canary caution there in mind.
- The calibration corpora must never be folded into a numbered cycle; if a
  future cycle capture accidentally overlaps their windows, `prepare-cycle`'s
  overlap check will catch it — do not weaken that check.
- Deferred: nothing in this plan depends on the perf/refactor findings
  deferred in `plans/README.md`.
