# Plan 003R: Recover classifier generalization on a fresh evaluation cycle

> **Executor instructions**: Treat evaluation cycle v1 as terminal evidence,
> never as tuning data. Keep every model decision inactive and every downstream
> object non-public until a new cycle passes its one-time holdout. Human-review
> infrastructure from Plan 004 may proceed in parallel under that restriction.
>
> **Drift check (run first)**: run `npm run evaluation:validate-cycles` and
> confirm v1 is `OPENED_FAILED`; confirm `createClassifyComment` has no decision
> activation input; confirm `CLASSIFIER_ENABLED` defaults to false.

## Status

- **Execution status**: IN PROGRESS — cycle locking, v1 terminal hashes,
  no-rerun enforcement, model non-activation, authenticated manual decision
  review, the fresh immutable v2 split, blind annotation validation, the
  dual-kappa comparison gate, fail-closed gold finalization, and the inactive
  two-stage application router are implemented. Independent v2 annotation and
  development evaluation remain.
- **Priority**: P1
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: Plan 003 implementation, not a passing v1 promotion gate
- **Can run in parallel with**: Plan 004 in mandatory-review/shadow-only mode
- **Category**: evaluation / classifier architecture / safety

## Why this matters

Sol's development result did not generalize. The holdout failures were semantic
boundary errors: rejected comments became Expert notes, Discoveries were
demoted, and the model never used review. Schema, evidence, URL, and adversarial
safety held. Recovery therefore needs new evidence and a clearer decision
architecture, not weaker thresholds or more attempts against the opened split.

## Scope

**In scope**:

- A fresh later HN source window with at least 90 unique canonical comments.
- A deterministic development/holdout split frozen before annotation or prompt
  work, with zero row overlap with earlier cycles.
- Two independent annotation passes and explicit adjudication.
- Development-only design of a two-stage decision flow:
  1. materially technical vs rejected/uncertain;
  2. Discovery vs Expert note plus grounded extraction.
- An application-owned ambiguity policy that routes uncertainty to review;
  model-owned `review.required` is only an additional signal.
- Development comparison of the smallest practical set of provider/model
  configurations, starting with Sol-low as the capability baseline and Terra
  only if it can meet the same gates at lower cost.
- One explicitly authorized holdout opening after candidate freeze.

**Out of scope**:

- Any prompt, schema, threshold, label, or routing change derived from v1
  holdout rows.
- Reusing or rerunning `holdout-v1.json` as a promotion gate.
- Fine-tuning before several hundred reviewed production examples exist.
- Automatic publication, export, subject merge, or model-decision activation.

## Steps

### Step 1: Capture and freeze cycle v2

Capture a new bounded selection window after the v1 maximum comment ID. Build
canonical comment/root packets with the existing provenance and URL rules. Run
`evaluation:capture-source`, then the corpus-size-neutral
`evaluation:build-source`, then `evaluation:prepare-cycle` before labeling.
Commit the source digest, immutable split, and holdout ID file. Every capture
uses a new directory and refuses overwrite.

**Verify**: `npm run evaluation:validate-cycles` reports v1 terminal and v2
`SPLIT_FROZEN`; overlap is zero; v2 has at least 90 rows; source text and secrets
are absent from command output.

**Execution evidence (2026-08-28):** Captured the later, non-overlapping
Telegram window `32947..33037` in `evaluation/captures/v2`: 91 occurrences
resolved to exactly 90 unique canonical HN comments. The capture manifest is
frozen with Telegram digest
`f9f6a7e02365bc5e0ab1890dd06ca2762d4ec4cf7d412e2d6e53cf95cef7ab89`
and HN digest
`5155a9d479ec27575061d820ae58b0fe2b1c5ad5f43321bc3e84534a25b4276a`.
Cycle v2 pins source digest
`5734ee729f88db253a2cb21195afe70953070034a81b3f77db2b4bf7401108fd`
and a deterministic 63-row development / 27-row sealed holdout split.
Validation reports v1 `OPENED_FAILED`, v2 `SPLIT_FROZEN`, and zero row overlap.

### Step 2: Independently annotate and adjudicate

Give both annotators the rubric and bounded packets, not model predictions or
historical aggregate targets. Track material relevance separately from the
Discovery/Expert decision. Adjudicate disagreements with written rationales and
require Cohen's kappa ≥ 0.75. Holdout labels must not influence implementation
or candidate selection.

**Verify**: distinct annotator hashes, exact evidence reproduction, valid URL
candidate IDs, complete development/holdout partition, and kappa gate pass.

**Workflow implementation (2026-08-28):** `evaluation:prepare-annotations`
verifies the frozen v2 source and creates separate A/B packet directories with
different deterministic row orders and no holdout or prediction fields.
`evaluation:validate-annotation` enforces complete independent pass files,
separate material-relevance and primary-class labels, exact evidence, opaque
grounded URL IDs, and canonical review/rejection codes. Packet preparation
does not label rows or mutate the cycle manifest; the two independent passes
and adjudication are still required.

`evaluation:compare-annotations` revalidates both passes, requires distinct
file hashes, and independently gates both primary-class and material-relevance
Cohen's kappa at 0.75. It refuses to write on failure and otherwise creates an
exclusive, holdout-blind packet containing only decision disagreements, their
bounded source, and both proposals. It still does not adjudicate or mutate the
cycle.

`evaluation:finalize-annotations` accepts strict, source-free adjudication
responses only after both kappa gates pass. It requires every disagreement
exactly once, a written bounded rationale, and selection of the complete A or B
proposal rather than a third outcome. Agreed decisions use a fixed A-extraction
policy. Only after all validation succeeds does it create the canonical pass,
response, and `gold.v2` artifacts and advance the manifest to `ANNOTATED` with
their hashes. The workflow is ready, but it has not been run: real independent
passes and owner adjudication remain required.

### Step 3: Implement two-stage classification on v2 development only

Version the compatibility set. Stage A decides whether the comment contains
reusable materially technical content or must be rejected/reviewed. Stage B
runs only for material comments and chooses Discovery or Expert note while
producing grounded extraction. A deterministic application router requires
review for ambiguity, conflicting signals, high-risk advice, root-only claims,
missing URLs, or other existing mandatory reasons. It must not learn rules from
v1 holdout cases.

**Verify**: table-driven boundary tests cover all stage transitions; every
uncertain path is inactive and review-required; fixture evaluation remains
fully grounded with zero invented URLs.

**Structural implementation (2026-08-28):** `classification-prompt.v4` makes
the existing material-relevance and retained-class fields an explicit ordered
Stage A / Stage B protocol. `decision-router.v1` independently cross-checks the
two stages, discards extraction and normalizes the result to `REVIEW` when the
signals conflict, and derives mandatory review for missing or ambiguous URLs,
root-only discoveries, confidence below the fixed 0.95 automatic threshold,
and every existing model-reported risk signal. Provider output remains in the
run audit while only the routed output may become an inactive decision. The
router cannot activate a decision and every model result still receives the
unpromoted-provider review gate.

This compatibility set was designed from the pre-existing rubric and safety
policy, not from any v1 holdout case. It remains unselected and cannot be
quality-evaluated or promoted until real v2 annotations produce `gold-v2`;
therefore Step 3 is not yet complete.

### Step 4: Select economically after accuracy

Start with one Sol-low development run. If it passes, measure whether Terra-low
can meet the identical gates for less. Do not sweep reasoning levels or models
without a written hypothesis. Use cached-token-aware actual estimates and stop
once one cost-effective candidate passes.

**Verify**: each paid run has one hypothesis and one report; no holdout rows are
evaluated; the selected candidate passes every fixed development gate.

### Step 5: Open the new holdout once

Record the exact candidate and passing development report in the v2 cycle
manifest. With explicit owner authorization, run holdout mode using `--cycle
v2`. Record either terminal outcome without tuning or retrying.

**Verify**: one holdout report, zero activated decisions, exact frozen hashes,
all gates pass before provider promotion, or the cycle is terminal failed and
classification remains disabled.

## Done criteria

- [ ] Fresh v2 source, independent annotations, adjudication, and immutable
      split validate.
- [ ] No v1 holdout row or diagnostic was used to tune the compatibility set.
- [ ] Two-stage routing and application-owned mandatory review are tested.
- [x] Model decisions remain inactive; only authenticated manual review can
      activate them.
- [ ] One v2 candidate passes all development and one-time holdout gates.
- [ ] Provider ADR is updated with quality, latency, and actual cost evidence.
- [ ] Global and evaluation verification gates pass.

## STOP conditions

- Freshness, independence, or holdout custody cannot be demonstrated.
- Kappa is below 0.75.
- Any proposed recovery rule is justified only by v1 holdout behavior.
- No development candidate meets the existing precision and grounding gates.
- Any path can activate or publish a model decision before review/promotion.
