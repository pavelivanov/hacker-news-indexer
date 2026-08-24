# ADR 0005: Classifier provider selection

- Status: blocked after measured OpenAI GPT-5.6 Luna and Terra rejection
- Date: 2026-08-25

## Context

Plan 003 requires provider selection from measured development-split results,
not model reputation. The frozen corpus contains 69 development rows and 29
holdout rows. The owner supplied an OpenAI API credential outside source
control and approved `gpt-5.6-luna` as the first live candidate, followed by
`gpt-5.6-terra`. The local `.env` file is gitignored and the credential was
never printed, logged, or written to a report.

The live adapter uses the Responses API with strict JSON Schema output, a
45-second deadline, no tools, no parallel tool calls, `store: false`, and one
fresh repair-free retry only when the deterministic application validator
allows it. Provider schema constraints are adapted to OpenAI's supported JSON
Schema subset, while the complete application-owned schema and semantic
validators remain authoritative after the response.

OpenAI documents Luna as a cost-sensitive, high-volume model and Terra as a
balanced intelligence/cost model; both support structured outputs:
<https://developers.openai.com/api/docs/models/gpt-5.6-luna> and
<https://developers.openai.com/api/docs/models/gpt-5.6-terra>. The request
shape follows the current Responses API and Structured Outputs documentation:
<https://developers.openai.com/api/docs/guides/structured-outputs>.

## Decision

Reject all four measured GPT-5.6 Luna and Terra configurations. None passes
the Plan 003 development gates. Terra achieves perfect discovery precision,
but low discovery recall, excess false-positive expert notes, poor evidence
origin accuracy, and validation failures keep both reasoning levels below the
fixed acceptance thresholds. Do not evaluate the 29-row holdout, enable the
worker adapter, publish decisions, or weaken any threshold.

Keep classification in fixture/shadow mode with `CLASSIFIER_ENABLED=false`.
Plan 003 remains blocked until the owner approves a stronger candidate, which
must first pass the same 69-row development benchmark. `gpt-5.6-sol` is the
recommended next candidate, but it is not selected by this decision.

## Measurements

All live reports exercise only the 69-row development split. Reports contain
aggregate metrics and configuration metadata; they contain no prompts, source
documents, credentials, or provider outputs.

| Metric                           | Required | Luna low | Luna medium | Terra low | Terra medium |
| -------------------------------- | -------: | -------: | ----------: | --------: | -----------: |
| Macro F1                         |   ≥ 0.85 |   0.8332 |      0.7754 |    0.7457 |       0.7862 |
| Discovery precision              |   ≥ 0.93 |   0.8571 |      0.8333 |      1.00 |         1.00 |
| Expert-note precision            |   ≥ 0.88 |   0.7143 |      0.6364 |    0.6667 |       0.6818 |
| URL-grounding precision          |     1.00 |     1.00 |        1.00 |      1.00 |         1.00 |
| Invented URL count               |        0 |        0 |           0 |         0 |            0 |
| Evidence-origin accuracy         |   ≥ 0.97 |   0.6552 |      0.5862 |    0.6207 |       0.6207 |
| Evidence-span validation         |     1.00 |     1.00 |        1.00 |      1.00 |         1.00 |
| Schema-valid outputs             |  ≥ 0.995 |   0.9710 |      0.9565 |    0.9710 |       0.9420 |
| Adversarial tool/network actions |        0 |        0 |           0 |         0 |            0 |
| Latency p95                      |   < 60 s |  7.030 s |    10.604 s |   5.667 s |      7.344 s |
| Estimated upper-bound API cost   | recorded | $0.04572 |    $0.05116 |  $0.40319 |     $0.42709 |

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
- Terra low report:
  `evaluation/reports/benchmark-openai-gpt-5-6-terra-low-v1.json`
- Terra low report SHA-256:
  `eb00ff3f9f84e94527b8df94033256d3f80ee48f34862b103dc894d58e4b30b9`
- Terra medium report:
  `evaluation/reports/benchmark-openai-gpt-5-6-terra-medium-v1.json`
- Terra medium report SHA-256:
  `ea2eb7df2b08905891669a486a530ae7bd01a807a641cb0b51e51f39da05c362`
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
