# ADR 0005: Classifier provider selection

- Status: No provider promoted; GPT-5.6 Sol low failed the sealed holdout
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

Adopt evaluation report v3 and `classification-prompt.v3`. It supplies the
content-class and review rubric, requires review to be independent of the
content class when one can be determined, matches discoveries by supported
subject name, separates abstention/coverage from classified quality, separates
schema from application validation, and records safe bounded subject/opaque-URL
diagnostics without source or provider bodies. It also separates URL grounding
from subject-name matching so valid candidate IDs are not double-penalized by a
supported name-granularity disagreement.

Select GPT-5.6 Sol with low reasoning as the development winner. On the 65 rows
where the independent annotators agreed, it achieves 1.00 macro F1, Discovery
precision, Expert-note precision, classification coverage, and URL-grounding
precision. It also passes schema/application validity, origin/span consistency,
invention, latency, and adversarial gates. Luna is much cheaper but fails the
stable Discovery, Expert-note, and URL precision gates and timed out on two
development rows. A later cost-instrumented Terra-low run passes every gate
except stable Discovery precision, so it does not replace Sol.

Five development rows had been changed from unanimous `EXPERT_NOTE` labels to
`REJECTED` to reproduce the historical aggregate counts. V3 restores the two
independent annotations and prevents future development consensus overrides.
The four actual annotation disagreements stay outside hard selection metrics.
The sealed 29-row holdout subset was byte-for-byte unchanged before its single
formal evaluation.

Keep `CLASSIFIER_ENABLED=false`. The explicitly authorized Sol-low/prompt-v3
holdout failed stable macro F1 and Expert-note precision. Sol is therefore not
eligible for production, the worker adapter and publication remain disabled,
and the opened holdout must not be used for tuning or rerun as a fresh gate.
The application classification use case marks every model decision as
review-required and cannot activate one at all; activation is reserved for the
future authenticated human-review path.
Evaluation cycle manifests pin source, annotation, split, candidate, and result
hashes, and live holdout mode refuses an already-opened cycle before making a
provider request.

### Inactive recovery compatibility set

For fresh cycle v2, define but do not promote `classification-prompt.v4` with
`classification.v1` and `decision-router.v1`. Prompt v4 makes material
relevance Stage A and permits retained-class/extraction Stage B only for a
material result. The deterministic application router cross-checks both
stages, normalizes contradictions to `REVIEW`, discards contradictory
extraction, and derives mandatory review for missing or ambiguous canonical
URLs, root-only discoveries, confidence below 0.95, and existing risk signals.
The original provider output remains auditable separately from the routed
decision.

This design follows the existing annotation rubric and conservative review
policy; it does not encode any v1 holdout case or diagnostic. It is not a
provider selection and has not earned a quality claim. Real independent v2
annotation and development-only evaluation must precede any paid comparison,
candidate freeze, or holdout authorization. `CLASSIFIER_ENABLED` remains
`false`, and the unpromoted-model review gate still applies to every result.

## Measurements

All model-selection reports exercise only the 69-row development split. The
single promotion report exercises the 29-row holdout only after configuration
selection and explicit authorization. V2/v3 reports add comment IDs,
expected/predicted enum values, review flags, counts, and failure codes for
diagnosis. They contain no prompts, source bodies, credentials, or raw provider
outputs.

### Sealed v3 holdout result

The selected `gpt-5.6-sol` low / `classification-prompt.v3` compatibility set
was evaluated once on the sealed 29-row holdout with no prompt, model,
reasoning, schema, threshold, or scoring-rule changes. The report is preserved
as the terminal promotion result. It fails stable macro F1 at 0.6190 and stable
Expert-note precision at 0.4000. On the stable slice, five rejected comments
were promoted to Expert notes, one Discovery was demoted to Expert note, and
one Discovery was rejected. This is a substantive class-generalization failure
despite perfect Discovery precision, URL-grounding precision, validation,
coverage, and safety metrics.

| Metric                          | Required |  Full 29 | Stable 23 |
| ------------------------------- | -------: | -------: | --------: |
| Macro F1                        |   ≥ 0.85 |   0.6254 |    0.6190 |
| Discovery precision             |   ≥ 0.93 |     1.00 |      1.00 |
| Discovery recall                | recorded |   0.4000 |    0.3333 |
| Expert-note precision           |   ≥ 0.88 |   0.4000 |    0.4000 |
| Expert-note recall              | recorded |     1.00 |      1.00 |
| URL-grounding precision         |     1.00 |     1.00 |      1.00 |
| URL-grounding recall            | recorded |   0.6000 |    0.5000 |
| Classification coverage         |   ≥ 0.80 |     1.00 |      1.00 |
| Automatic coverage              | recorded |     1.00 |         — |
| Automatic accuracy              | recorded |   0.6552 |         — |
| Evidence-origin consistency     |   ≥ 0.97 |     1.00 |         — |
| Gold-origin agreement           | recorded |   0.9000 |    0.8333 |
| Evidence-span validation        |     1.00 |     1.00 |         — |
| JSON/schema-valid outputs       |  ≥ 0.995 |     1.00 |         — |
| Application-valid outputs       |   ≥ 0.95 |     1.00 |         — |
| Invented URL count              |        0 |        0 |         — |
| Adversarial tool/network calls  |        0 |        0 |         — |
| Latency p95                     |   < 60 s |  7.992 s |         — |
| Usage-priced cost, all 33 calls | recorded | $0.26266 |         — |
| All-input-uncached comparison   | recorded | $0.43484 |         — |
| Highest-input-rate bound        | recorded | $0.50490 |         — |

- V3 Sol-low holdout report:
  `evaluation/reports/holdout-openai-gpt-5-6-sol-low-v3.json`
- V3 Sol-low holdout report SHA-256:
  `e6044a42c1a594d525fc03d79e925c1b6351f08947359d1df094d0affd21f145`
- Total usage: 70,060 input tokens (52,640 cached, 17,321 cache-write,
  99 other uncached) and 7,730 output tokens across 33 terminal runs
- Prompt version: `classification-prompt.v3`
- Prompt hash:
  `30d391239d4301e68a242fdad1bf992a61c2ca0891ff986860383990c70b3001`
- Gold corpus SHA-256:
  `7d23a114c404e30858a1b9c3d2ab7f66349ec41a3cdbf5405dd5fcd0447a95ce`

### Selected v3 measurement

The v3 stable slice contains 65 development rows with unanimous independent
annotations. Prompt v3 adds only measured edge rules for quoted-news reactions,
facetious product claims, and supplied URL selection. The paid Sol run was made
once; its URL metrics were then deterministically rescored from safe bounded
diagnostics after URL grounding was decoupled from subject-name matching. The
report records the pre-rescore hash and `providerCalls: 0` for that operation.

| Metric                               |   Required |  Full 69 | Stable 65 |
| ------------------------------------ | ---------: | -------: | --------: |
| Macro F1                             |     ≥ 0.85 |   0.9464 |      1.00 |
| Discovery precision                  |     ≥ 0.93 |   0.8750 |      1.00 |
| Expert-note precision                |     ≥ 0.88 |   0.9545 |      1.00 |
| URL-grounding precision              |       1.00 |     1.00 |      1.00 |
| URL-grounding recall                 |   recorded |   0.7273 |    0.8000 |
| Discovery-extraction precision       |   recorded |   0.6250 |    0.7143 |
| Discovery-extraction recall          |   recorded |   0.6250 |    0.7143 |
| Classification coverage              |     ≥ 0.80 |     1.00 |      1.00 |
| Automatic coverage                   |   recorded |   0.8551 |         — |
| Automatic accuracy                   |   recorded |   0.9831 |         — |
| Evidence-origin consistency          |     ≥ 0.97 |     1.00 |         — |
| Gold-origin agreement                | diagnostic |   0.8519 |    0.8800 |
| Evidence-span validation             |       1.00 |     1.00 |         — |
| JSON/schema-valid outputs            |    ≥ 0.995 |     1.00 |         — |
| Application-valid outputs            |     ≥ 0.95 |     1.00 |         — |
| Invented URL count                   |          0 |        0 |         — |
| Adversarial tool/network calls       |          0 |        0 |         — |
| Latency p95                          |     < 60 s | 10.295 s |         — |
| Legacy uncached main-run upper bound |   recorded | $0.89249 |         — |

- V3 Sol-low report:
  `evaluation/reports/benchmark-openai-gpt-5-6-sol-low-v3.json`
- V3 report SHA-256:
  `740bf905103abb9e072c6a38c63ece2b80cbb0063a18583a792146b9c50ed108`
- Pre-rescore report SHA-256:
  `3c2264e6e7543ef8ac1bee05b2106d9df1087a4d3ea42cc3e978730c48aa9450`
- Prompt version: `classification-prompt.v3`
- Prompt hash:
  `30d391239d4301e68a242fdad1bf992a61c2ca0891ff986860383990c70b3001`
- Gold corpus SHA-256:
  `7d23a114c404e30858a1b9c3d2ab7f66349ec41a3cdbf5405dd5fcd0447a95ce`

Two stable discoveries retain diagnostic subject-granularity differences:
`Flight Simulator map` versus `Raymond Chen's articles`, and `Kagi` versus its
`AI Assistant` feature. Both primary classes are correct; the Kagi feature is
routed to review for a missing canonical URL. These do not weaken or bypass
the required URL precision gate.

### Cost-instrumented Terra v3 challenge

After the Sol selection, Terra low was run exactly once with the same prompt,
corpus, structured-output configuration, and development split to test whether
the lower-priced model could retain the required quality. It achieved 0.9269
stable macro F1 and passed Expert-note precision, URL grounding, schema,
application, evidence, latency, and adversarial gates. It failed stable
Discovery precision at 0.8571 against the required 0.93. The stable errors were
one incidental mention promoted to Discovery, one operational report rejected,
and one named library demoted from Discovery to Expert note. The thresholds
were not weakened, and Terra is rejected for this configuration.

This run introduced usage-accounting version 2. Classification runs now retain
`cached_tokens` and `cache_write_tokens` from the Responses API alongside total
input and output usage. The evaluator prices uncached input, cache hits, cache
writes, and output separately and includes the four adversarial calls. OpenAI's
published Terra standard rates at measurement time were $2.00/M uncached input,
$0.20/M cached input, $2.50/M cache-write input, and $12.00/M output. The
$0.314318 estimate is therefore materially more representative than the
$0.504972 all-input-uncached comparison and $0.583056 bound obtained by pricing
every input token at the highest published input/cache-write rate. Older
reports did not retain token details or adversarial usage, so their recorded
cost remains a non-comparable all-input-uncached estimate; rerunning Sol solely
to improve accounting is not justified.

| Metric                             | Required |  Full 69 | Stable 65 |
| ---------------------------------- | -------: | -------: | --------: |
| Macro F1                           |   ≥ 0.85 |   0.9126 |    0.9269 |
| Discovery precision                |   ≥ 0.93 |   0.7778 |    0.8571 |
| Expert-note precision              |   ≥ 0.88 |   0.9524 |    0.9500 |
| URL-grounding precision            |     1.00 |     1.00 |      1.00 |
| URL-grounding recall               | recorded |   0.8182 |    0.8000 |
| Discovery-extraction precision     | recorded |   0.6000 |    0.6250 |
| Discovery-extraction recall        | recorded |   0.7500 |    0.7143 |
| Classification coverage            |   ≥ 0.80 |     1.00 |      1.00 |
| Automatic coverage                 | recorded |   0.9130 |         — |
| Automatic accuracy                 | recorded |   0.9365 |         — |
| Evidence-origin consistency        |   ≥ 0.97 |     1.00 |         — |
| Evidence-span validation           |     1.00 |     1.00 |         — |
| JSON/schema-valid outputs          |  ≥ 0.995 |     1.00 |         — |
| Application-valid outputs          |   ≥ 0.95 |     1.00 |         — |
| Invented URL count                 |        0 |        0 |         — |
| Adversarial tool/network calls     |        0 |        0 |         — |
| Latency p95                        |   < 60 s |  7.733 s |         — |
| Usage-priced cost, all 73 calls    | recorded | $0.31432 |         — |
| All-input-uncached comparison      | recorded | $0.50497 |         — |
| Highest-input-rate bound, 73 calls | recorded | $0.58306 |         — |

- V3 Terra-low report:
  `evaluation/reports/benchmark-openai-gpt-5-6-terra-low-v3.json`
- V3 Terra-low report SHA-256:
  `46db8572123e8f70d05df5fdcbf68d2d2f7d62ab78df2c43d96c5de159d208ca`
- Total usage: 156,168 input tokens (116,795 cached, 39,154 cache-write,
  219 other uncached) and 16,053 output tokens across 73 terminal runs
- Prompt version: `classification-prompt.v3`
- Prompt hash:
  `30d391239d4301e68a242fdad1bf992a61c2ca0891ff986860383990c70b3001`
- Gold corpus SHA-256:
  `7d23a114c404e30858a1b9c3d2ab7f66349ec41a3cdbf5405dd5fcd0447a95ce`

### Historical corrected v2 measurements

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

Luna low passes stable macro F1, coverage, origin/span consistency, schema,
application validity, invention, latency, and adversarial gates, but fails all
three class/extraction precision gates. Its two 45-second timeouts are counted
as invalid abstentions and reduce application validity to 0.9710. Luna's cost
advantage does not compensate for its lower task quality, and it is rejected as
the provider candidate.

| Metric                         |   Required |  Full 69 | Stable 60 |
| ------------------------------ | ---------: | -------: | --------: |
| Macro F1                       |     ≥ 0.85 |   0.8436 |    0.8893 |
| Discovery precision            |     ≥ 0.93 |   0.6667 |    0.7000 |
| Expert-note precision          |     ≥ 0.88 |   0.7500 |    0.8750 |
| URL-grounding precision        |       1.00 |   0.6364 |    0.6000 |
| Discovery-extraction precision |   recorded |   0.4615 |    0.4545 |
| Discovery-extraction recall    |   recorded |   0.7500 |    0.7143 |
| Classification coverage        |     ≥ 0.80 |   0.9710 |    0.9667 |
| Automatic coverage             |   recorded |   0.8696 |         — |
| Automatic accuracy             |   recorded |   0.9333 |         — |
| Evidence-origin consistency    |     ≥ 0.97 |     1.00 |         — |
| Gold-origin agreement          | diagnostic |   0.8095 |    0.8947 |
| Evidence-span validation       |       1.00 |     1.00 |         — |
| JSON/schema-valid outputs      |    ≥ 0.995 |     1.00 |         — |
| Application-valid outputs      |     ≥ 0.95 |   0.9710 |         — |
| Invented URL count             |          0 |        0 |         — |
| Adversarial tool/network calls |          0 |        0 |         — |
| Latency p95                    |     < 60 s |  9.368 s |         — |
| Estimated upper-bound API cost |   recorded | $0.05239 |         — |

- V2 Luna-low report:
  `evaluation/reports/benchmark-openai-gpt-5-6-luna-low-v2.json`
- V2 report SHA-256:
  `010565cb6e5edea566a8bbc9c4399aee7bfd425c31bb72cea7745c7da2b870db`
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

## Promotion outcome

The holdout was explicitly authorized, opened exactly once, and failed the
unchanged promotion gates. The thresholds were not weakened and classification
remains disabled. Any future classifier effort must begin a new development
cycle and reserve a new untouched holdout before a new promotion attempt; this
opened holdout may be used only as historical evidence, not as a tuning target
or reusable gate.
