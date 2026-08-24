# Plan 003: Implement grounded classification and the evaluation harness

> **Executor instructions**: Complete Plans 001–002 first. Build deterministic input, output, and evidence validation before connecting any model provider. Never give the classifier tools, browsing, filesystem access, credentials, or direct network capability beyond the single provider request.
>
> **Drift check (run first)**: verify Plans 001 and 002 are `DONE`; run the seed replay and confirm 100 occurrences, 98 comments, 55 roots, five root mismatches, and two multipart groups. Stop if those counts differ.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/002-implement-deterministic-ingestion.md`
- **Category**: feature / safety / evaluation
- **Planned at**: unborn repository with no `HEAD`, 2026-08-24

## Why this matters

Classification creates all retained knowledge objects and is the largest source of false positives. The system must prove that outputs are schema-valid, evidence-grounded, URL-grounded, and robust to prompt injection before it can publish or export anything.

## Current state expected from dependencies

- A frozen 98-comment canonical seed corpus is reproducibly ingested.
- Canonical HN comment/root HTML and normalized text exist, with grounded anchor URLs and provenance.
- No classifier, classification schema, gold labels, or model selection exists.
- The research document preserves aggregate labels `13 DISCOVERY / 22 EXPERT_NOTE / 63 REJECTED`, but it does not contain the complete per-comment adjudication file. That file must be recovered or rebuilt with owner approval.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Schema tests | `npm test -- --run tests/unit/classification` | all pass |
| Evaluation replay | `npm run test:evaluation -- --mode replay` | all deterministic validation tests pass |
| Provider benchmark | `npm run eval -- --corpus evaluation/gold-v1.jsonl --provider <name>` | report written; no source text in console logs |
| Shadow run | `npm run classify:shadow -- --corpus seed-v1` | 98 terminal classification runs; no publication |
| Clean migration | `npm run db:test:reset && npm run db:migrate:deploy` | includes `0003_classification`, exit 0 |

## Scope

**In scope**:

- `packages/contracts/src/classification-v1.ts` and generated JSON Schema.
- `packages/ports/src/classifier.ts`.
- `packages/application/src/{build-classifier-input,classify,validate-output,validate-evidence}.ts`.
- `packages/adapters/src/classifier/{fixture,selected-provider}.ts`, prompts, and provider mapping.
- Migration `0003_classification` and repositories.
- Worker classify job and shadow command.
- `evaluation/{gold-v1.jsonl,annotation-schema.json,README.md,reports}` and evaluation scripts.
- Adversarial and replay fixtures; unit/integration/evaluation tests.
- `docs/decisions/0005-classifier-provider.md` after measured selection.

**Out of scope**:

- Subject merging, feed publication, review decisions, export, frontend.
- Fetching linked pages or accepting model-created URL strings.
- Automatic prompt repair, agent loops, tool calls, or model browsing.
- Training/fine-tuning a model.
- Logging prompts or full source documents.

## Git workflow

- Branch: `codex/003-grounded-classification`.
- Keep deterministic schema/validator commits separate from provider integration.
- Do not push or expose provider benchmark data externally unless instructed.

## Steps

### Step 1: Recover and freeze the gold annotation corpus

Define `evaluation/annotation-schema.json` and `evaluation/gold-v1.jsonl`. Each row must include comment ID, primary class, zero or more expected discoveries, optional expert note, evidence origin, exact normalized-text spans, URL candidate IDs, review flags, and annotator/adjudication metadata.

Recover the original 98 per-comment judgments if available. Otherwise, have two independent annotators label from the frozen fixtures using `docs/annotation-guide.md`, adjudicate disagreements, and verify totals remain `13/22/63`. Do not infer missing labels from the aggregate counts or representative examples.

Reserve a deterministic 30% holdout by checked-in ID list. Compute Cohen's kappa and require at least 0.75 before model selection. The file may contain public HN text excerpts needed for spans, but must not contain Telegram session data or secrets.

**Verify**: `npm run evaluation:validate-corpus` → 98 unique comment IDs, totals `13/22/63`, every evidence span reproduces normalized source text, holdout is exactly the checked-in ID set, kappa ≥ 0.75.

### Step 2: Implement strict classification.v1 contracts

Model the research schema exactly with a strict runtime schema (`additionalProperties: false`) and TypeScript types:

- primary decision: `DISCOVERY | EXPERT_NOTE | REJECTED | REVIEW`;
- decision confidence and material-technical relevance;
- bounded rejection reasons;
- discovery subject type/name/aliases/description/evidence origin/span IDs/URL candidate IDs/root-only flag/confidence;
- optional expert note type/title/summary/spans/related subject names/qualifiers/confidence;
- review-required flag and reasons.

Set explicit maximum lengths/counts. A `REJECTED` result must contain neither discoveries nor a note. A `DISCOVERY` may also carry a supporting expert note, while remaining one primary class.

Generate provider-consumable JSON Schema from the same source and snapshot-test it so TypeScript/runtime/provider shapes cannot drift independently.

**Verify**: schema tests accept one canonical fixture per class and reject unknown fields/enums, NaN/out-of-range confidence, excess lengths/counts, and rejected-with-content payloads.

### Step 3: Build bounded, provenance-aware model input

Create an input builder that supplies:

- canonical comment plain text/HTML-derived blocks up to 24 KiB;
- root title up to 512 characters and root text up to 16 KiB;
- no more than 50 URL candidates, each as opaque `url:<n>` plus source/origin metadata;
- deterministic source document IDs and span coordinate maps;
- a 32 KiB total normalized-input cap and a stored truncation map.

Never include Telegram-rendered auto-links as authoritative candidates. URL strings may appear in input only as supplied candidates; the output contract accepts candidate IDs, not new URLs. Do not silently truncate through a potential evidence span.

**Verify**: input-builder tests are byte-for-byte deterministic, respect all limits, preserve a reversible truncation map, and contain no credentials/config diagnostics.

### Step 4: Implement deterministic post-model validators

Validate in this order: JSON parse, strict schema, semantic invariants, candidate-ID membership, evidence span reproduction, origin consistency, root-relevance gate, and bounded fields. Reject the entire extraction if any discovery/subject name lacks a supporting span or if `ROOT_STORY`/`BOTH` origin lacks matching spans.

The root-relevance gate must reject a generic root project when the selected comment is incidental, a joke, or irrelevant. Evidence span hashes must be stored for every retained claim.

Represent failures with stable error codes. The application may make one fresh, repair-free retry for invalid JSON/schema; a second failure becomes review/error. Never send invalid output back to the model for repair.

**Verify**: mutation tests corrupt each field of valid fixtures and prove every listed invariant fails closed; URL invention and evidence mismatch always reject.

### Step 5: Add migration 0003 and append-only run storage

Create `classification_runs`, `content_decisions`, and `evidence_spans` with prompt/schema/model/config versions, input/output hashes, latency, token usage, status/error code, and active-run/manual-override references. Runs are append-only; never overwrite historical output. Store full provider output only under the retention policy and never in logs.

Add idempotency on `(comment_id, input_hash, prompt_version, schema_version, model_config_id)`. Enqueue `CLASSIFY_COMMENT` only after canonical resolution succeeds.

**Verify**: clean migration, append-only repository tests, duplicate-run idempotency, active-decision switch, and evidence-span foreign-key tests pass.

### Step 6: Implement a fixture classifier and provider-neutral port

The `ClassifierPort` accepts the bounded request and returns unknown JSON plus provider metadata. Implement a fixture/replay adapter first. Application code must not import a vendor SDK type.

Provider adapter requirements:

- one request, strict structured response when supported;
- 45-second timeout;
- no tools or parallel tool calls;
- no prompt/source logging;
- stable retry classification for timeout, rate limit, provider 5xx, invalid output, and terminal auth/config errors;
- model/config ID persisted on every run.

**Verify**: all application/integration tests pass with the fixture adapter and with a fake provider covering timeout/rate-limit/invalid-output paths before any live call occurs.

### Step 7: Select the provider through evaluation, then document it

Benchmark the model options actually available to the owner on the development split; do not use the holdout for prompt tuning. Record model ID, provider, structured-output mode, temperature/seed settings if supported, prompt hash, cost/latency, privacy/logging settings, and measured metrics in `docs/decisions/0005-classifier-provider.md`.

Select by acceptance metrics and operational fit, not reputation. If no candidate meets the minimum precision/grounding thresholds, do not weaken the thresholds; remain in fixture/shadow mode and report the gap.

**Verify**: a machine-readable report exists for every evaluated configuration; the ADR cites the winning report and explains rejected candidates.

### Step 8: Run shadow classification and enforce acceptance gates

Wire `CLASSIFY_COMMENT` jobs and run all 98 seed comments without publishing. Produce confusion matrices, per-class precision/recall/F1, evidence-origin accuracy, schema validity, invented URL count, latency, and review-rate metrics. Run adversarial fixtures containing fake system prompts, JSON closers, tool requests, and URL invention requests.

Required gates:

- macro F1 ≥ 0.85;
- Discovery precision ≥ 0.93;
- Expert-note precision ≥ 0.88;
- URL-grounding precision 1.00 and invented URL count 0;
- evidence-origin accuracy ≥ 0.97 and span validation 1.00;
- schema-valid outputs ≥ 99.5%;
- adversarial tool/network actions 0.

**Verify**: `npm run classify:shadow -- --corpus seed-v1 && npm run test:evaluation -- --mode shadow` → report meets every gate or the plan is `BLOCKED` with exact failing metrics; no data is published.

## Test plan

- Strict schema valid/invalid matrices and schema snapshot.
- Input cap/truncation/candidate-origin tests.
- Evidence offset/hash/origin and root-relevance mutation tests.
- Prompt-injection fixtures with no tool/network execution path.
- Append-only/idempotent run persistence.
- Provider fake error taxonomy and one repair-free retry.
- Gold-corpus metrics, confusion matrices, and prompt/schema regression comparisons.

## Done criteria

- [ ] The complete 98-item gold corpus exists and validates; it was not fabricated from aggregate counts.
- [ ] Classifier input/output and provider schema derive from versioned strict contracts.
- [ ] Every retained claim/subject/URL is deterministically validated.
- [ ] No model-returned URL string can enter storage.
- [ ] Migration 0003 applies from an empty database.
- [ ] A provider decision is documented with measured reports, or the plan is explicitly blocked in shadow mode.
- [ ] All acceptance gates pass on the frozen evaluation run.
- [ ] Global verification gate plus `npm run test:evaluation` passes.
- [ ] Plan 003 is marked `DONE` only after the gates pass.

## STOP conditions

- The complete per-comment gold labels cannot be recovered or independently re-adjudicated.
- Inter-annotator kappa is below 0.75.
- A provider requires tools, browsing, prompt logging, or unconstrained text output to perform the task.
- No evaluated model meets precision/grounding gates.
- Evidence offsets cannot be reproduced after normalization/truncation.
- Implementation would accept arbitrary model-returned URLs.

## Maintenance notes

Treat prompt, schema, input builder, model config, and normalizer versions as one compatibility set. Any change to one requires an evaluation report before promotion. Reviewers should focus on fail-open paths, logging, evidence coordinate drift, and accidental provider coupling.
