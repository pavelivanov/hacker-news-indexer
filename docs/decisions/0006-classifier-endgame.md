# ADR 0006: Classifier endgame

- Status: Assist-only endpoint adopted after v3 annotation failure
- Date: 2026-09-04

On 2026-09-05 the owner superseded the mandatory-review restriction for private
browsing with [ADR 0007](0007-classifier-results-feedback.md): classifier results
may be viewed immediately and corrected optionally during use. The evaluation
history and approved-reader/export rules below remain unchanged. This document
records the earlier endgame decision and its evidence.

## Context

Evaluation cycle v1 is terminal `OPENED_FAILED`, and v2 is terminal
`ANNOTATION_FAILED`. Before calibration began, commit `87de916` pre-registered
the endgame rule: if either second-batch Cohen's κ value remained below `0.75`,
the project would adopt the assist-only endpoint and open no further cycles;
otherwise it would run one fresh v3 cycle under the existing gates.

The rewritten guide was tested on two permanently excluded calibration
batches. The capture command requires at least 90 Telegram messages, while
only 62 messages existed after v2 at capture time. The transport capture
therefore covered `33010..33099`, but its v2-era prefix `33010..33037` was
excluded before packet creation. Calibration v1 contains the 31 fresh rows
selected by `33038..33068`; calibration v2 contains the 31 rows selected by
`33069..33099`. Neither batch has or may acquire a cycle manifest.

Annotators A and B received differently ordered packets, the guide, and the
pass schema, with no model output, holdout assignment, historical label totals,
or other pass. After batch 1 they discussed only its four disagreements and
agreed on a stricter technology-policy, terse-correction, analogy, security,
and product-experience boundary. That clarification was added to the guide
before either annotator saw batch 2. There was no discussion between the
batch-2 passes.

## Evidence

| Batch          | Rows | Exact agreement | Primary-class κ | Materiality κ | Result |
| -------------- | ---: | --------------: | --------------: | ------------: | ------ |
| v1 calibration |   31 |              27 |    0.7606177606 |  0.7529880478 | Pass   |
| v2 calibration |   31 |              29 |    0.8896797153 |  0.8697478992 | Pass   |

The source manifests, distinct pass hashes, body-free comparisons, and batch-1
discussion memos are under `evaluation/calibration/`. The production annotation
parser validated both passes before each comparison.

The fresh v3 cycle then used the non-overlapping Telegram window
`33100..33189`, resolving 90 occurrences to 90 unique canonical comments and
freezing a 63-row development / 27-row sealed-holdout split before annotation.
Both blind pass files validated across all 90 rows and had distinct hashes.
Their body-free comparison recorded 76 exact-decision agreement rows,
primary-class kappa `0.7326543603`, and material-relevance kappa
`0.7578870139`, against the unchanged `0.75` requirement. The primary-class
gate failed, so the owner script sealed v3 as `ANNOTATION_FAILED`, preserved
the pass files and comparison report, and wrote no adjudication packet or gold
corpus. No provider call occurred and the holdout remained sealed.

## Decision

Both batch-2 κ values exceeded the pre-registered `0.75` threshold, so the
project proceeded with one fresh v3 cycle exactly as documented in
`evaluation/README.md`.

V3 uses the later non-overlapping Telegram window `33100..33189`. When message
`33189` became public on 2026-09-04, the capture resolved 90 occurrences to 90
unique canonical HN comments. The immutable split was frozen before annotation
with 63 development and 27 sealed holdout rows. Its independent annotation
comparison then failed the primary-class gate at `0.7326543603`. This is the
v3 decision point pre-registered in `docs/annotation-guide.md`: adopt the
assist-only endpoint, open no v4, and make no paid v3 development or holdout
call. `CLASSIFIER_ENABLED` remains false for automatic decisions, all
classifier output is restricted to mandatory human review, and no production
quality claim is made.

## Consequences

Plans 003R and 009 are complete at the assist-only endpoint. Row-level v3
disagreements must not be reconciled or used for further rubric, prompt, or
model work, and no further annotation cycle may be opened. Plan 007 may
continue independently with classification excluded from automatic decisions:
`CLASSIFIER_ENABLED=false`, no provider credentials, zero model activation,
and mandatory human review for any later classifier-assisted output.
