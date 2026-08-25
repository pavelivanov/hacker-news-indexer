# ADR 0005: Classifier provider selection

- Status: blocked on development-gold adjudication and URL grounding
- Date: 2026-08-25

## Context

Plan 003 requires provider selection from measured development-split results,
not model reputation. The frozen corpus contains 69 development rows and 29
holdout rows. The owner supplied an OpenAI API credential outside source
control and approved `gpt-5.6-luna` as the first live candidate, followed by
`gpt-5.6-terra` and `gpt-5.6-sol`. The local `.env` file is gitignored and the
credential was never printed, logged, or written to a report.

The live adapter uses the Responses API with strict JSON Schema output, a
45-second deadline, no tools, no parallel tool calls, `store: false`, and one
fresh repair-free retry only when the deterministic application validator
allows it. Provider schema constraints are adapted to OpenAI's supported JSON
Schema subset, while the complete application-owned schema and semantic
validators remain authoritative after the response.

OpenAI documents Luna as a cost-sensitive, high-volume model, Terra as a
balanced intelligence/cost model, and Sol as the frontier GPT-5.6 model. All
three support structured outputs:
<https://developers.openai.com/api/docs/models/gpt-5.6-luna> and
<https://developers.openai.com/api/docs/models/gpt-5.6-terra>, and
<https://developers.openai.com/api/docs/models/gpt-5.6-sol>. The request shape
follows the current Responses API and Structured Outputs documentation:
<https://developers.openai.com/api/docs/guides/structured-outputs>.

## Decision

Do not interpret the v1 results as evidence that GPT-5.6 Sol lacks the required
capability. The v1 prompt omitted the annotation rubric, treated valid review
abstentions as class errors, compared discoveries by array position, conflated
application validation with JSON Schema validity, and compared non-unique gold
span choices as if they were deterministic origin failures.

Adopt evaluation report v2 and `classification-prompt.v2`. It supplies the
content-class and review rubric, requires review to be independent of the
content class when one can be determined, matches discoveries by supported
subject name, separates abstention/coverage from classified quality, separates
schema from application validation, and records safe per-case diagnostic
metadata without source or provider bodies.

GPT-5.6 Sol low is the only candidate measured with the corrected compatibility
set. It passes macro F1, Expert-note precision, schema/application validity,
origin/span consistency, invention, latency, and adversarial gates on the 60
rows where both annotators agreed and no consensus label was overridden. It
still fails Discovery precision and URL-grounding precision. Seven of eleven
full-corpus disagreements are on machine-disputed gold rows; those rows need
human adjudication before they can be hard selection labels.

Keep `CLASSIFIER_ENABLED=false`. Do not evaluate the 29-row holdout, enable the
worker adapter, or publish decisions until the remaining stable Discovery and
URL cases are diagnosed and the disputed development labels are independently
adjudicated.

## Measurements

All live reports exercise only the 69-row development split. V2 reports add
comment IDs, expected/predicted enum values, review flags, counts, and failure
codes for diagnosis. They contain no prompts, source bodies, credentials, or
raw provider outputs.

### Corrected v2 measurement

The stable slice contains 60 rows with annotator consensus and no later
consensus override. Full adjudicated metrics remain visible and are not
discarded; they are not treated as hard selection evidence until the nine
machine-disputed rows receive independent adjudication.

| Metric                         |   Required |  Full 69 | Stable 60 |
| ------------------------------ | ---------: | -------: | --------: |
| Macro F1                       |     ≥ 0.85 |   0.8375 |    0.9580 |
| Discovery precision            |     ≥ 0.93 |   0.7778 |    0.8750 |
| Expert-note precision          |     ≥ 0.88 |   0.6667 |    0.9375 |
| URL-grounding precision        |       1.00 |   0.7500 |    0.7500 |
| Classification coverage        |     ≥ 0.80 |     1.00 |      1.00 |
| Automatic coverage             |   recorded |   0.8841 |         — |
| Automatic accuracy             |   recorded |   0.9016 |         — |
| Evidence-origin consistency    |     ≥ 0.97 |     1.00 |         — |
| Gold-origin agreement          | diagnostic |   0.8636 |    0.8500 |
| Evidence-span validation       |       1.00 |     1.00 |         — |
| JSON/schema-valid outputs      |    ≥ 0.995 |     1.00 |         — |
| Application-valid outputs      |     ≥ 0.95 |     1.00 |         — |
| Invented URL count             |          0 |        0 |         — |
| Adversarial tool/network calls |          0 |        0 |         — |
| Latency p95                    |     < 60 s |  9.180 s |         — |
| Estimated upper-bound API cost |   recorded | $0.88356 |         — |

- V2 Sol-low report:
  `evaluation/reports/benchmark-openai-gpt-5-6-sol-low-v2.json`
- V2 report SHA-256:
  `bae72fef1e9a35716867a9a6c505eef606cbc785879d10a38b7b4cceef1d330f`
- Prompt version: `classification-prompt.v2`
- Prompt hash:
  `7b25b31cc6a927e433f2bbfb1acce5f58d75c740875071759aea7d0a5be1fa3d`

### Historical v1 measurements

These reports preserve the original experiment but are superseded for model
selection by v2 because the prompt and metric definitions were not valid for
the intended review-oriented classifier.

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

| Metric                           | Required |  Sol low | Sol medium |
| -------------------------------- | -------: | -------: | ---------: |
| Macro F1                         |   ≥ 0.85 |   0.7585 |     0.7309 |
| Discovery precision              |   ≥ 0.93 |     1.00 |     0.7500 |
| Expert-note precision            |   ≥ 0.88 |   0.8125 |     0.7647 |
| URL-grounding precision          |     1.00 |     1.00 |       1.00 |
| Invented URL count               |        0 |        0 |          0 |
| Evidence-origin accuracy         |   ≥ 0.97 |   0.5172 |     0.5517 |
| Evidence-span validation         |     1.00 |     1.00 |       1.00 |
| Schema-valid outputs             |  ≥ 0.995 |   0.9710 |     0.9710 |
| Adversarial tool/network actions |        0 |        0 |          0 |
| Latency p95                      |   < 60 s |  8.894 s |   10.872 s |
| Estimated upper-bound API cost   | recorded | $0.73086 |   $0.81432 |

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
- Sol low report:
  `evaluation/reports/benchmark-openai-gpt-5-6-sol-low-v1.json`
- Sol low report SHA-256:
  `166dab8bcac355cffe61d2e63e281a17d5d0951e7c247ec6c923bba94632c467`
- Sol medium report:
  `evaluation/reports/benchmark-openai-gpt-5-6-sol-medium-v1.json`
- Sol medium report SHA-256:
  `ce4bbb3d0174c0b83577ed04dc22ab686ea4b81d957f42331e0561555fec0e54`
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

1. Independently adjudicate the nine development rows with annotator
   disagreement or consensus override; do not force the historical aggregate
   totals.
2. Diagnose the stable Discovery false positive and per-case URL mismatches
   using the safe v2 diagnostic format.
3. Rerun the corrected prompt/model compatibility set and meet every stable
   precision, URL, validation, safety, latency, and coverage gate.
4. Only then evaluate the sealed 29-row holdout once and enable the selected
   adapter if the holdout also passes.

If no candidate meets the thresholds, classification remains in shadow mode;
the thresholds are not weakened.
