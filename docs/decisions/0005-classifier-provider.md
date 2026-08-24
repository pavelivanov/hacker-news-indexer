# ADR 0005: Classifier provider selection

- Status: blocked pending a measured live-provider benchmark
- Date: 2026-08-24

## Context

Plan 003 requires provider selection from measured development-split results,
not model reputation. The frozen corpus contains 69 development rows and 29
holdout rows. The current workspace has no configured classifier credential or
owner-approved live model configuration, so no real provider request can be
made and no real provider can honestly be selected.

## Decision

Keep classification in fixture/shadow mode and leave
`CLASSIFIER_ENABLED=false`. Do not select or wire a live provider until the
owner supplies a credential and model candidates for a development-only
benchmark.

The provider-neutral port, fixed 45-second deadline, strict structured-output
schema, error taxonomy, one fresh repair-free retry, and fail-closed worker path
are implemented. The checked-in fixture adapter has no tools, browsing,
filesystem, credentials, or network path.

## Measurements

`evaluation/reports/benchmark-fixture-v1.json` exercises the 69-row development
split. `evaluation/reports/shadow-fixture-v1.json` exercises all 98 rows. Both
are deterministic gold replays through the production input, schema,
validation, evidence-hashing, and application paths; their perfect scores are
pipeline baselines and are explicitly **not** evidence of model quality.

- Gold corpus SHA-256:
  `826c97f5678b3ab56d2970d498668051f90f86ac6ee615cfdf7e4643eed87e7a`
- Fixture benchmark report SHA-256:
  `ff4681180e978c3f0c74dccd641226de95249de9d1f727016ca5c0b9c305a2c8`
- Fixture shadow report SHA-256:
  `e477d50feb13dbca37528118621a034c911731dfe0c94de39177c3dac2da820c`
- Prompt hash:
  `10f0ba3a3e44902ebbc5c03cafd4de7dbc66a797320ee9471612ca0ba4a41a01`
- Schema: `classification.v1`
- Structured-output mode: strict JSON Schema
- Tool/network actions exposed to the classifier: zero
- Source or prompt bodies written to reports/logs: zero

## Unblocking criteria

1. The owner supplies a classifier credential outside source control and names
   the model configurations that are actually available.
2. Each candidate is benchmarked on the 69-row development split with model
   ID, configuration, structured-output settings, latency, token usage, cost,
   and privacy/logging settings recorded.
3. A candidate meets every Plan 003 precision and grounding gate.
4. Only then is the 29-row holdout evaluated once and the selected adapter
   enabled.

If no candidate meets the thresholds, classification remains in shadow mode;
the thresholds are not weakened.
