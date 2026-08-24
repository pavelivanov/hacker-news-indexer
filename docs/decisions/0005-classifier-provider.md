# ADR 0005: Classifier provider selection

- Status: blocked after measured OpenAI GPT-5.6 Luna rejection
- Date: 2026-08-24

## Context

Plan 003 requires provider selection from measured development-split results,
not model reputation. The frozen corpus contains 69 development rows and 29
holdout rows. The owner supplied an OpenAI API credential outside source
control and approved `gpt-5.6-luna` as the first live candidate. The local
`.env` file is gitignored and the credential was never printed, logged, or
written to a report.

The live adapter uses the Responses API with strict JSON Schema output, a
45-second deadline, no tools, no parallel tool calls, `store: false`, and one
fresh repair-free retry only when the deterministic application validator
allows it. Provider schema constraints are adapted to OpenAI's supported JSON
Schema subset, while the complete application-owned schema and semantic
validators remain authoritative after the response.

OpenAI documents Luna as a cost-sensitive, high-volume model with structured
output support:
<https://developers.openai.com/api/docs/models/gpt-5.6-luna>. The request shape
follows the current Responses API and Structured Outputs documentation:
<https://developers.openai.com/api/docs/guides/structured-outputs>.

## Decision

Reject both measured GPT-5.6 Luna configurations. Neither passes the Plan 003
development gates, and medium reasoning regresses relative to low reasoning.
Do not evaluate the 29-row holdout, enable the worker adapter, publish
decisions, or weaken any threshold.

Keep classification in fixture/shadow mode with `CLASSIFIER_ENABLED=false`.
Plan 003 remains blocked until the owner approves a stronger candidate, which
must first pass the same 69-row development benchmark. A balanced model such
as `gpt-5.6-terra` is the recommended next candidate, but it is not selected by
this decision.

## Measurements

Both live reports exercise only the 69-row development split. Reports contain
aggregate metrics and configuration metadata; they contain no prompts, source
documents, credentials, or provider outputs.

| Metric                           | Required |  Luna low | Luna medium |
| -------------------------------- | -------: | --------: | ----------: |
| Macro F1                         |   ≥ 0.85 |    0.8332 |      0.7754 |
| Discovery precision              |   ≥ 0.93 |    0.8571 |      0.8333 |
| Expert-note precision            |   ≥ 0.88 |    0.7143 |      0.6364 |
| URL-grounding precision          |     1.00 |      1.00 |        1.00 |
| Invented URL count               |        0 |         0 |           0 |
| Evidence-origin accuracy         |   ≥ 0.97 |    0.6552 |      0.5862 |
| Evidence-span validation         |     1.00 |      1.00 |        1.00 |
| Schema-valid outputs             |  ≥ 0.995 |    0.9710 |      0.9565 |
| Adversarial tool/network actions |        0 |         0 |           0 |
| Latency p95                      |   < 60 s |   7.030 s |    10.604 s |
| Estimated upper-bound API cost   | recorded | $0.045715 |   $0.051156 |

The cost estimate applies the published uncached input and output rates to all
reported tokens, so it is an upper bound when prompt caching is effective.
Account-level retention or Zero Data Retention status is not inferred by the
repository and must be confirmed separately before production enablement.

- Low report:
  `evaluation/reports/benchmark-openai-gpt-5-6-luna-low-v1.json`
- Low report SHA-256:
  `49cfa85cb01e2f18d467ef2747b64da30af326ad1c679d66bc8de0bbd1459cdb`
- Medium report:
  `evaluation/reports/benchmark-openai-gpt-5-6-luna-medium-v1.json`
- Medium report SHA-256:
  `2c4fc0eb07841545161aa70a7cf30e88f91da7142f5d76626cc9d5d8c9687e92`
- Gold corpus SHA-256:
  `826c97f5678b3ab56d2970d498668051f90f86ac6ee615cfdf7e4643eed87e7a`
- Prompt hash:
  `10f0ba3a3e44902ebbc5c03cafd4de7dbc66a797320ee9471612ca0ba4a41a01`
- Schema: `classification.v1`
- Tool/network actions exposed to the classifier: zero
- Source or prompt bodies written to reports/logs: zero

The checked-in fixture benchmark and shadow reports remain deterministic gold
replays through the production input, schema, validation, evidence-hashing,
and application paths. Their perfect scores prove pipeline behavior and are
not evidence of model quality.

## Unblocking criteria

1. The owner approves a stronger model configuration available through the
   configured provider credential.
2. The candidate is benchmarked on the 69-row development split with model ID,
   reasoning configuration, structured-output settings, latency, token usage,
   cost, and privacy/logging settings recorded.
3. The candidate meets every Plan 003 precision and grounding gate.
4. Only then is the 29-row holdout evaluated once and the selected adapter
   enabled.

If no candidate meets the thresholds, classification remains in shadow mode;
the thresholds are not weakened.
