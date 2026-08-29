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
descriptive validation output, not an input or invariant. The two pre-existing
holdout overrides remained unchanged through the single formal holdout opening
and may not be used for subsequent prompt or provider tuning.

Evidence uses JavaScript UTF-16 offsets into the normalized documents generated
by `npm run evaluation:build-source`. Every span stores its exact text and
SHA-256. URL references use only the packet's opaque `url:<n>` IDs; arbitrary
URLs are structurally absent from the gold rows.

The development/holdout split is immutable. `holdout-v1.json` selects 29 IDs by
sorting all comment IDs on `SHA-256(gold-v1-holdout:<commentId>)` and taking the
first 29. The holdout must not be used for prompt or provider tuning.

`evaluation/cycles/v1.json` is the machine-readable terminal record for this
cycle. It pins the source, both independent annotation passes, gold corpus,
split, selected development report, and holdout result by SHA-256. Validate all
cycle records without printing source text:

```bash
npm run evaluation:validate-cycles
```

Cycle v2 was captured and frozen on 2026-08-28 before annotation or prompt
work. Its fresh public Telegram window is `32947..33037`: 91 occurrences resolve
to exactly 90 unique canonical HN comments, with zero overlap with v1. The
immutable split contains 63 development rows and 27 sealed holdout rows. The
capture evidence is in `evaluation/captures/v2`, the canonical packets are in
`evaluation/source-v2.json`, and `evaluation/cycles/v2.json` pins source digest
`5734ee729f88db253a2cb21195afe70953070034a81b3f77db2b4bf7401108fd`.
The next gate is two independent annotation passes and adjudication; neither
annotator may see model predictions or the sealed holdout assignment.

Prepare two blind, differently ordered packet sets outside the repository. The
command verifies the frozen source digest, refuses an existing output
directory, emits 15-row chunks by default, and prints only body-free metadata:

```bash
npm run evaluation:prepare-annotations -- \
  --cycle v2 \
  --output-dir /tmp/hn-v2-annotation-packets
```

Give annotator A only `annotator-a/`, and annotator B only `annotator-b/`,
together with `docs/annotation-guide.md` and
`evaluation/annotation-pass-schema-v2.json`. Do not give either annotator the
packet manifest, cycle manifest, holdout file, other annotation pass, model
outputs, or historical aggregate targets. Packet rows contain no holdout
assignment or model prediction.

Validate each completed JSONL pass independently without printing source text:

```bash
npm run evaluation:validate-annotation -- \
  --cycle v2 --annotator A --input /secure/path/annotator-a.jsonl
npm run evaluation:validate-annotation -- \
  --cycle v2 --annotator B --input /secure/path/annotator-b.jsonl
```

The validator requires every frozen comment exactly once, the expected
annotator identity and method, separate material-relevance and primary-class
labels, exact source-reproducing evidence, grounded opaque URL candidate IDs,
canonical review/rejection codes, and class/content consistency. Do not update
the cycle manifest until both passes are complete and independently validated.

Once both files validate, compare them and prepare the adjudicator's bounded
input:

```bash
npm run evaluation:compare-annotations -- \
  --cycle v2 \
  --annotator-a /secure/path/annotator-a.jsonl \
  --annotator-b /secure/path/annotator-b.jsonl \
  --output /secure/path/adjudication-v2.jsonl
```

The command validates the immutable cycle and both passes again, requires
distinct pass-file hashes, computes separate Cohen's kappa values for primary
class and material relevance, and requires both to be at least 0.75. A failed
gate writes no adjudication file. A passing gate creates the output exactly
once and includes only decision disagreements, their bounded source packet,
and the two proposals; it contains no holdout assignment. Comparison does not
mutate the cycle manifest or create gold labels.

Give that packet only to the adjudicator, along with `docs/annotation-guide.md`
and `evaluation/annotation-adjudication-schema-v2.json`. The returned JSONL
must contain exactly one resolution for every packet row. Finalize only after
reviewing the response file:

```bash
npm run evaluation:finalize-annotations -- \
  --cycle v2 \
  --annotator-a /secure/path/annotator-a.jsonl \
  --annotator-b /secure/path/annotator-b.jsonl \
  --adjudication /secure/path/adjudication-responses-v2.jsonl
```

The finalizer revalidates the frozen source and holdout digests, distinct and
complete A/B passes, both kappa gates, and exact disagreement coverage. Each
resolution can select only the complete A or B proposal and requires a bounded
rationale. Consensus decisions retain A's grounded extraction by a fixed
deterministic policy. The command then exclusively creates the canonical A/B
pass files, the source-free adjudication response, and `gold-v2.jsonl`, before
atomically advancing `cycles/v2.json` to `ANNOTATED` with artifact hashes. It
prints aggregate metadata only and refuses existing artifacts or any later
cycle state. `evaluation/annotation-schema-v2.json` documents the resulting
gold rows. Do not run this command until the real independent passes and owner
adjudication are complete.

The inactive recovery compatibility set is `classification-prompt.v4`,
`classification.v1`, and `decision-router.v1`. The prompt orders materiality
before retained class and extraction. The application router independently
normalizes contradictory stages to review, discards their extraction, and
derives mandatory review reasons for structural grounding and confidence
conditions even when the model omits them. This set has no quality claim yet:
do not make a paid development run or select a candidate until v2 reaches
`ANNOTATED`, and never use the opened v1 holdout to tune it.

Evaluation report v4 records `decisionRouterVersion` and uses new `*-v4.json`
filenames so a prompt-v4 development run cannot overwrite any historical paid
v3 report. The checked-in v4 fixture reports exercise routing and pipeline
safety only; they are not model-quality evidence.

## Starting a fresh evaluation cycle

A replacement promotion gate must use a later, non-overlapping HN comment
window. Capture 90 to 150 new public `@hn_best_comments` messages into a new
directory; the command refuses to overwrite any capture file:

```bash
npm run evaluation:capture-source -- \
  --min-id FIRST_MESSAGE_ID \
  --max-id LAST_MESSAGE_ID \
  --output-dir evaluation/captures/v2
```

Build the canonical comment/root packets from that capture. This builder is
corpus-size-neutral; the cycle preparation gate, not the builder, enforces at
least 90 unique canonical comments:

```bash
npm run evaluation:build-source -- \
  evaluation/captures/v2/hn-items.json \
  evaluation/source-v2.json
```

Before either annotator labels a row or any prompt work starts, freeze the new
split exactly once:

```bash
npm run evaluation:prepare-cycle -- \
  --cycle v2 \
  --source evaluation/source-v2.json
```

The command refuses duplicate IDs, fewer than 90 rows, overlap with any earlier
cycle, an HN ID window that is not later than the preceding cycle, skipped
cycle numbers, or an existing output. It writes `holdout-v2.json` and
`cycles/v2.json` with exclusive-create semantics and a deterministic 30% split.
The split fields and source digest must never change after that commit.

Annotator A and B then label independently. Record both distinct file digests
and the adjudicated gold digest in the cycle manifest. Only development rows
may guide taxonomy, prompt, model, reasoning-effort, or price decisions. After
one configuration passes every development gate, record that exact candidate
and its passing report, set the cycle to `CANDIDATE_SELECTED`, and review the
manifest change before opening the holdout. Do not lower a gate after candidate
selection.

Live development evaluation is cycle-aware and is blocked until the selected
cycle is `ANNOTATED`. The evaluator derives the source and gold paths from the
manifest, verifies both frozen digests and the exact development partition,
and refuses `--corpus` or `--source` overrides. Live report names include the
cycle ID, and an exclusive `.attempt` marker is written before the first
provider request, so neither a concurrent retry nor a later cycle can overwrite
or duplicate the exact attempt. A successful report removes its marker; a
failed/interrupted run deliberately leaves the marker for review rather than
silently retrying paid calls:

```bash
npm run eval -- \
  --cycle v2 \
  --provider openai \
  --model gpt-5.6-sol \
  --reasoning-effort low
```

If the report passes, review its metrics, cost, configuration, cycle, and
artifact hashes before freezing it exactly once:

```bash
npm run evaluation:select-candidate -- \
  --cycle v2 \
  --report evaluation/reports/benchmark-v2-openai-gpt-5-6-sol-low-v4.json
```

Candidate selection requires the current prompt/schema/router compatibility
set, a passing live development report with zero activated decisions, the
exact source/gold digests and row count, and an `ANNOTATED` manifest. It
atomically advances the cycle to `CANDIDATE_SELECTED`; fixture reports, failed
reports, path overrides, and repeated selection are rejected.

Live holdout mode requires the matching cycle explicitly:

```bash
npm run eval -- \
  --mode holdout \
  --cycle v2 \
  --provider openai \
  --model <frozen-model> \
  --reasoning-effort <frozen-effort>
```

The evaluator refuses a cycle whose holdout was already opened, lacks a frozen
passing candidate, or differs in corpus, provider, model configuration, prompt
version, or prompt hash. Cycle v1 is terminal `OPENED_FAILED`, so it cannot be
run again even if a matching development report is present.

Validate the corpus without printing source text:

```bash
npm run evaluation:build-source
npm run evaluation:validate-corpus
```

The checked-in `benchmark-fixture-v3.json` and `shadow-fixture-v3.json` reports
are deterministic gold replays through the production validation path. They
prove pipeline behavior, not model quality. Historical v1/v2 reports remain
for audit. The historical v1 live reports use only its 69-row development
split. New live reports use only the chosen cycle's manifest-pinned development
split until a configuration is selected. The selected Sol-low/prompt-v3
configuration failed its single 29-row v1 holdout; that opened split is never
a prompt-tuning set and cannot be reused as a fresh promotion gate.

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

## Subject identity and review-load evaluation

Plan 004 evaluates conservative subject identity independently from classifier
quality. The adjudicated pair corpus includes exact ecosystem coordinates,
canonical URLs, verified domains, root-scoped repeats, name-only suggestions,
and homonyms. The command rewrites a body-free versioned report and fails unless
precision is at least 0.97, recall is at least 0.90, and every policy outcome is
exact:

```bash
npm run evaluation:subjects
```

To replay the frozen seed classifications in mandatory-review shadow mode, use
a clean migrated database and run:

```bash
npm run seed:replay
npm run seed:materialize-shadow
npm run review:stats -- \
  --corpus seed-v1 \
  --output evaluation/reports/review-load-seed-v1.json
```

The shadow command validates all 98 bounded inputs before writing, refuses URL
candidate ordering drift, asserts that every decision requires review, and
asserts that no decision is active. Repeating it against the same database is
an idempotency check. The review-load report contains only corpus metadata and
aggregate task counts by priority, state, kind, and stable reason code; it does
not query or write source bodies.

## Live provider benchmark

The OpenAI benchmark adapter loads the ignored local `.env` file and requires
`CLASSIFIER_PROVIDER=openai`, `CLASSIFIER_API_TOKEN`, and `CLASSIFIER_MODEL`.
Classification can remain disabled while running development evaluation.

```bash
npm run eval -- \
  --cycle v2 \
  --provider openai \
  --reasoning-effort low \
  --concurrency 2
```

For v2, the command sends only the manifest-pinned 63-row development split,
uses strict JSON Schema output with no tools and `store: false`, and writes an
aggregate cycle-scoped report. Usage accounting includes the four adversarial
calls and separates uncached input, cached input, cache-write input, and output
tokens using the provider's token details. The report records the resulting
price estimate, an all-input-uncached comparison, and a conservative bound that
prices every input token at the highest published input/cache-write rate. Use
`--mode holdout` only after a development report passes every acceptance gate.
Never use the holdout for prompt, model, or reasoning-effort tuning. The
authorized Sol-low/prompt-v3 holdout has already run and failed; the cycle guard
rejects any rerun.
