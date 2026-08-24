# Plan 006: Implement the FindThatProject export outbox

> **Executor instructions**: Complete Plan 004 first. This plan creates a pull-based contract only; do not write to or mutate FindThatProject. Every initial export requires explicit human approval.
>
> **Drift check (run first)**: verify Plan 004 is `DONE`; run classification and subject evaluations; confirm review audit is append-only and all export candidates are reviewable.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: HIGH
- **Depends on**: `plans/004-implement-subjects-and-review.md`
- **Category**: integration / data integrity
- **Planned at**: unborn repository with no `HEAD`, 2026-08-24

## Why this matters

FindThatProject should receive only high-confidence, URL-grounded Discoveries and must never be contaminated by generic root projects, Expert notes, or unreviewed model output. A versioned outbox makes delivery replayable, auditable, and retractable without coupling databases.

## Current state expected from dependencies

- Discoveries, subjects, grounded URL candidates, validated evidence, review tasks, and manual approvals exist.
- No export table, contract, endpoint, consumer offset, or downstream mutation exists.
- The downstream integration mechanism remains unconfirmed; the research recommendation is pull-based outbox.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Migration | `npm run db:test:reset && npm run db:migrate:deploy` | includes `0006_export`, exit 0 |
| Export tests | `npm test -- --run tests/unit/export` | all pass |
| Outbox integration | `npm run test:integration -- --run tests/integration/export-outbox.test.ts` | all pass |
| Holdout audit | `npm run export:audit -- --corpus holdout-v1` | precision ≥ 0.98 and zero false-positive exports during rollout |
| Contract test | `npm run test:contract -- --target findthatproject --dry-run` | validates only; no downstream mutation |

## Scope

**In scope**:

- Versioned FindThatProject export contracts.
- Migration `0006_export`, outbox repository, eligibility policy, revision/retraction logic.
- Authenticated pull/ack API.
- Export-purpose review tasks and explicit approval-to-outbox use case.
- Fixture consumer and non-mutating downstream contract test.
- Eligibility, idempotency, replay, retraction, precision, and security tests.

**Out of scope**:

- Direct writes to FindThatProject.
- Expert-note export in v1.
- Automatic approval during initial rollout.
- External-page verification or invented/corrected URLs.
- Changing FindThatProject's canonical descriptions.

## Git workflow

- Branch: `codex/006-findthatproject-export`.
- Commit contract/policy, persistence, and API/tests separately.
- Do not push, deploy, or call a mutating downstream endpoint without explicit instruction.

## Steps

### Step 1: Freeze the export eligibility policy and v1 contract

An eligible Discovery must satisfy all conditions atomically:

- Discovery status approved;
- grounded canonical `http`/`https` URL supplied by HN evidence;
- explicit allowed subject type;
- classification confidence ≥ 0.95;
- URL and subject confidence ≥ 0.95;
- selected comment materially discusses the subject;
- no unresolved review flags;
- evidence origin/spans present;
- explicit human approval for export during rollout.

Define `findthatproject.discovery.v1` with immutable export ID, revision, discovery ID, bounded subject name/type/canonical URL/evidence-based summary, HN comment/root IDs, Telegram message IDs, evidence origin/bounded excerpt hash or allowed excerpt, confidence, and reviewed timestamp. Expert notes are structurally impossible in this schema.

**Verify**: strict contract tests accept the research example shape and reject unknown fields, non-HTTP schemes, missing provenance/evidence, and expert-note payloads.

### Step 2: Add migration 0006 and transactional outbox insertion

Create `export_outbox` and consumer acknowledgement state with destination, discovery ID, revision, payload, payload hash, immutable idempotency key, delivery state, timestamps, and error/ack metadata. Unique key: `(destination, discovery_id, revision)` plus immutable `export_id`.

Outbox insertion must occur in the same transaction as the export-purpose review approval and must re-check every eligibility condition under lock. Repeating the same approval yields the same row. Never overwrite payloads; corrections/retractions increment revision.

**Verify**: integration tests cover concurrent approvals, duplicate commands, eligibility changing between review and transaction, immutable rows, and monotonic revisions.

### Step 3: Implement correction and retraction behavior

If a previously exported discovery changes, becomes unavailable, loses grounded URL/evidence, or is rejected, create a new revision representing correction/retraction. Never silently delete the previous export. A consumer acknowledges `export_id + revision`, so old acknowledgements cannot acknowledge a new revision.

**Verify**: state-machine tests cover approve → correct → retract → replay and prove revisions/acks are monotonic and idempotent.

### Step 4: Implement authenticated pull and acknowledgement endpoints

Add private, cursor-paginated endpoints:

```text
GET  /v1/exports/findthatproject/outbox?cursor=...&limit=...
POST /v1/exports/findthatproject/outbox/{export_id}/revisions/{revision}/ack
```

Use a dedicated export-consumer token distinct from the reviewer/API token. Store only a safe token verifier/hash when feasible; never log token/header values. Pull returns pending revisions in stable order. Ack requires an idempotency key and expected payload hash.

**Verify**: API/integration tests cover wrong token, cursor, bounded limit, replay, duplicate ack, wrong revision/hash, and no payload leakage in logs/errors.

### Step 5: Validate the downstream contract without mutation

Create a fixture consumer or schema-validation adapter that reads outbox payloads and validates them against the downstream owner's agreed contract. The contract test must be dry-run/non-mutating by default and must fail closed if the downstream contract is not approved.

During initial rollout, manually inspect every candidate and run the held-out corpus audit. Require export precision ≥ 0.98 and zero false-positive exports in the reviewed holdout before permitting automatic outbox insertion after approval.

**Verify**: dry-run contract command performs no network mutation; holdout audit meets both gates and writes a versioned report.

## Test plan

- Eligibility truth table for every required condition.
- Strict v1 schema and expert-note exclusion.
- Transactional/concurrent idempotent insertion.
- Correction/retraction/revision/ack state machine.
- Dedicated auth and log redaction.
- Non-mutating consumer contract fixture.
- Holdout precision and zero-false-positive rollout gate.

## Done criteria

- [ ] Migration 0006 applies cleanly from an empty DB.
- [ ] Ineligible/review-pending discoveries cannot enter the outbox.
- [ ] Expert notes are structurally and behaviorally excluded.
- [ ] Insert, pull, ack, replay, correction, and retraction are idempotent/auditable.
- [ ] Consumer credentials are separate and never logged.
- [ ] Export precision ≥ 0.98 and reviewed holdout false positives = 0.
- [ ] Contract test is non-mutating and downstream schema approval is recorded.
- [ ] Global gates pass and Plan 006 is `DONE`.

## STOP conditions

- The downstream owner has not approved a payload contract.
- Correct integration requires direct database coupling or unversioned writes.
- Any candidate lacks validated HN evidence or a grounded URL.
- The heldout export audit contains a false positive during initial rollout.
- A downstream test would mutate FindThatProject without explicit authorization.

## Maintenance notes

Treat the export schema as an external compatibility contract. Add a new schema version rather than changing v1 in place. Reviewers should scrutinize transactional eligibility re-checks, retraction semantics, token separation, and accidental Expert-note inclusion.
