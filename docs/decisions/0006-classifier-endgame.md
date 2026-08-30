# ADR 0006: Classifier endgame

- Status: Fresh v3 path selected; terminal provider outcome pending source availability
- Date: 2026-08-31

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
parser validated both passes before each comparison. Numbered-cycle validation
continues to report only v1 `OPENED_FAILED` and v2 `ANNOTATION_FAILED`.

## Decision

Both batch-2 κ values exceed the pre-registered `0.75` threshold. Proceed with
a fresh v3 cycle exactly as documented in `evaluation/README.md`; do not adopt
the assist-only endpoint at this decision point. `CLASSIFIER_ENABLED` remains
false, every model-derived decision remains inactive and mandatory-review, and
no production quality claim exists until v3 reaches a terminal holdout result.

V3 must use a later non-overlapping Telegram window beginning at message
`33100` or later. At the 2026-08-31 readiness check the public channel had
reached only `33102`, so the required 90-message window did not yet exist. No
cycle was opened because source freshness and minimum size could not be
demonstrated. Execution resumes when a bounded window through at least message
`33189` is publicly available.

## Consequences

Plan 003R and Plan 009 remain in progress at the fresh-source STOP condition.
The next permitted action is the v3 capture; weakening the size/freshness gate,
reusing calibration rows, opening an incomplete cycle, or switching to the
assist-only endpoint despite the passing result would violate the
pre-registered rule. Plan 007 may continue only under the existing inactive,
mandatory-human-review classifier posture until v3 decides the terminal
provider outcome.
