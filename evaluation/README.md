# Evaluation corpus

`gold-v1.jsonl` is the frozen, double-annotated evaluation set for the 98
canonical selected comments in the Plan 002 seed corpus. Each non-empty line is
one object matching `annotation-schema.json`.

The two annotation passes are independent and may not use the known aggregate
totals to choose individual labels. The final row records both proposed primary
classes, whether they disagreed, and the adjudication rationale. Cohen's kappa
is computed from the two pre-adjudication primary-class sequences.

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

The checked-in `benchmark-fixture-v1.json` and `shadow-fixture-v1.json` reports
are deterministic gold replays through the production validation path. They
prove pipeline behavior, not model quality. A report for a live provider must
use only the 69-row development split until a configuration is selected; the
29-row holdout is not a prompt-tuning set.

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
output with no tools and `store: false`, and writes an aggregate report. Use
`--mode holdout` only after a development report passes every acceptance gate.
Never use the holdout for prompt, model, or reasoning-effort tuning.
