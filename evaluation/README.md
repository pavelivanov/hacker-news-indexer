# Evaluation corpus

`gold-v1.jsonl` is the frozen, double-annotated evaluation set for the 98
canonical selected comments in the Plan 002 seed corpus. Each non-empty line is
one object matching `annotation-schema.json`.

The two annotation passes are independent and may not use the known aggregate
totals to choose individual labels. The final row records both proposed primary
classes, whether they disagreed, and the adjudication rationale. Cohen's kappa
is computed from the two pre-adjudication primary-class sequences.

Development consensus is authoritative: adjudication may choose between the
two proposed classes when annotators disagree, but may not override a unanimous
development label to reproduce historical aggregate totals. Counts are
descriptive validation output, not an input or invariant. Two pre-existing
holdout overrides remain sealed and unchanged until the holdout is formally
opened.

Evidence uses JavaScript UTF-16 offsets into the normalized documents generated
by `npm run evaluation:build-source`. Every span stores its exact text and
SHA-256. URL references use only the packet's opaque `url:<n>` IDs; arbitrary
URLs are structurally absent from the gold rows.

The development/holdout split is immutable. `holdout-v1.json` selects 29 IDs by
sorting all comment IDs on `SHA-256(gold-v1-holdout:<commentId>)` and taking the
first 29. The holdout must not be used for prompt or provider tuning.

Validate the corpus without printing source text:

```bash
npm run evaluation:build-source
npm run evaluation:validate-corpus
```

The checked-in `benchmark-fixture-v3.json` and `shadow-fixture-v3.json` reports
are deterministic gold replays through the production validation path. They
prove pipeline behavior, not model quality. Historical v1/v2 reports remain
for audit. A report for a live provider must use only the 69-row development
split until a configuration is selected; the 29-row holdout is not a
prompt-tuning set.

Report v3 separates classified quality from `REVIEW`/invalid abstention and
reports classification and automatic coverage. Discovery evidence is matched
by normalized supported subject names for extraction scoring. URL grounding is
scored independently: every emitted opaque candidate ID must belong to a gold
discovery on the same row, so a valid URL is not double-penalized merely because
the model and annotator chose different supported subject granularity. The
evidence-origin acceptance gate measures deterministic consistency between the
returned origin and cited span origins; agreement with the annotator's
non-unique span choice is retained as a diagnostic. JSON/schema validity and
complete application validation are separate metrics.

V3 reports contain a safe `cases` array with comment IDs, expected/predicted
enums, review flags, extraction counts, bounded supported subject names, opaque
URL candidate IDs, gold-adjudication status, and failure codes. They must never
contain prompts, source bodies, credentials, or raw provider output. Hard
model-selection metrics use the stable-gold slice where annotators agreed; full
metrics remain visible. Genuine disagreement rows remain diagnostic rather
than being silently treated as certain labels.

An already-paid v3 report produced before the independent URL metric was fixed
can be deterministically rescored from its complete safe diagnostics without a
provider call:

```bash
npm run evaluation:rescore-report -- --input evaluation/reports/<report>.json
```

Evaluation reports belong in `evaluation/reports/`. Provider responses, prompts,
and source bodies must not be written to logs.

## Live provider benchmark

The OpenAI benchmark adapter loads the ignored local `.env` file and requires
`CLASSIFIER_PROVIDER=openai`, `CLASSIFIER_API_TOKEN`, and `CLASSIFIER_MODEL`.
Classification can remain disabled while running development evaluation.

```bash
npm run eval -- --provider openai --reasoning-effort low --concurrency 2
```

The command sends only the 69-row development split, uses strict JSON Schema
output with no tools and `store: false`, and writes an aggregate report. Usage
accounting includes the four adversarial calls and separates uncached input,
cached input, cache-write input, and output tokens using the provider's token
details. The report records the resulting price estimate, an all-input-uncached
comparison, and a conservative bound that prices every input token at the
highest published input/cache-write rate. Use `--mode holdout` only after a
development report passes every acceptance gate. Never use the holdout for
prompt, model, or reasoning-effort tuning.
