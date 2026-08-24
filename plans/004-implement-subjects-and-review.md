# Plan 004: Implement subjects, discoveries, notes, and human review

> **Executor instructions**: Complete Plan 003 with passing evaluation gates. Keep all new content non-public until review policy makes it eligible. Update Plan 004 in `plans/README.md` only after audit/idempotency tests pass.
>
> **Drift check (run first)**: verify Plans 001–003 are `DONE`; run `npm run test:evaluation -- --mode replay`; confirm the active classification schema is `classification.v1` and the seed metrics still pass.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: `plans/003-implement-grounded-classification.md`
- **Category**: feature / data integrity / review
- **Planned at**: unborn repository with no `HEAD`, 2026-08-24

## Why this matters

Classifier output becomes useful only after it is converted into durable, deduplicated subjects and reading objects with a human correction path. This plan implements conservative identity rules, mandatory-review triggers, manual overrides, and a complete audit trail before any feed/export work.

## Current state expected from dependencies

- Validated classification runs and evidence spans exist for 98 seed comments.
- No subject, discovery, expert-note, review-task, or manual-override tables exist.
- Research rules: one comment may identify several subjects; one subject may collect multiple notes; notes never overwrite canonical subject descriptions; name-only merges require review.
- Migration sequencing refinement: `0005_review` is split from export so shadow output can be reviewed before Plan 006.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Migrations | `npm run db:test:reset && npm run db:migrate:deploy` | includes 0004 and 0005, exit 0 |
| Domain tests | `npm test -- --run tests/unit/subjects tests/unit/review` | all pass |
| Review integration | `npm run test:integration -- --run tests/integration/review-workflow.test.ts` | all pass |
| Dedup evaluation | `npm run evaluation:subjects` | precision ≥ 0.97, recall ≥ 0.90 |

## Scope

**In scope**:

- Migration `0004_subjects_and_notes`: URL candidates, subjects, aliases/mentions, discoveries, expert notes, and joins.
- Migration `0005_review`: review tasks, manual override/audit events, and supporting indexes.
- Domain policies under `packages/domain/src/{subjects,review}.ts`.
- Application use cases `packages/application/src/{materialize-classification,deduplicate-subjects,review}.ts`.
- Repositories and jobs needed to materialize validated runs.
- Hono review routes and auth/audit middleware.
- Dedup gold fixtures and unit/integration/evaluation tests.

**Out of scope**:

- Feed ranking/serving, frontend, external URL verification, and FindThatProject export.
- Automatic name-only subject merges.
- Replacing an official/canonical project description with an expert-note summary.
- Public or unauthenticated review endpoints.

## Git workflow

- Branch: `codex/004-subjects-review`.
- Commit schema, materialization/dedup, and review API separately.
- Do not push or deploy without instruction.

## Steps

### Step 1: Implement URL and subject identity policies

Canonicalize only supplied HN URL candidates. Allow `http`/`https`, preserve original and canonical forms, normalize host case/default ports/fragments, and remove only an explicit allowlist of tracking parameters. Do not follow redirects or fetch pages.

Compute subject identity in this order:

1. verified ecosystem coordinate (for example GitHub owner/repository or package coordinate);
2. canonical normalized URL;
3. verified official product domain;
4. normalized `(name, subject_type, disambiguating root/domain)`.

Name-only similarity produces a merge suggestion/review task, never an automatic merge. Preserve aliases and provenance. Add fixtures for NickelMenu, Plato, Ratatui, historical 15.ai, and same-name/different-domain cases.

**Verify**: subject-policy tests prove exact coordinate/URL matches merge, root-only duplicates collapse, name-only candidates do not merge, and unsafe/unprovided URLs cannot enter the policy.

### Step 2: Add migration 0004 and idempotent materialization

Create `url_candidates`, `subjects`, `subject_mentions`, `discoveries`, `expert_notes`, and `expert_note_subjects` with the research fields and constraints. Every mention/discovery/note field derived from the classifier must reference evidence spans and the source classification run.

Root-story-only discovery identity is `(resolved_root_story_id, subject_dedup_key, extraction_version)`. Comment-origin discoveries remain separate when they introduce genuinely distinct subjects. Materializing the same active classification twice must not duplicate anything.

An expert note can enrich a subject with caveats, experience, comparisons, operational details, corrections, and security observations; it cannot mutate canonical subject name/URL/official description without an explicit reviewed action.

**Verify**: clean migration and `materialization.test.ts` prove idempotency, many-to-many relations, evidence FKs, root-only collapse, and distinct comment-origin subjects.

### Step 3: Encode mandatory-review policy

Review is required for:

- all FindThatProject candidates during initial rollout;
- missing/ambiguous canonical URL;
- name-only merge suggestion;
- root-story-only discovery;
- legal, medical, or security recommendation;
- destructive/evasion-oriented advice;
- low confidence;
- prompt-injection signal;
- deleted/flagged content;
- Telegram/HN divergence;
- conflicting evidence origins.

Use stable reason codes and a deterministic priority function. Policy-auto-approved content is allowed only for low-risk local reading and must still retain provenance; export is never auto-approved during rollout.

**Verify**: a table-driven test has at least one positive and one negative case for every reason code and snapshots the priority order.

### Step 4: Add migration 0005 for review and append-only audit

Create `review_tasks` and `manual_override_events`. Review task transitions are `OPEN -> APPROVED | REJECTED | SUPERSEDED`; reopening creates a new task/revision rather than erasing history. Manual overrides record actor identifier, timestamp, previous/new value hashes, reason, and affected classification/entity IDs.

Use optimistic versioning on mutations. Two concurrent decisions cannot both succeed. Never hard-delete audit events.

**Verify**: repository integration tests cover transition matrix, stale-version conflict, repeated identical command idempotency, reopen/supersede, and immutable audit history.

### Step 5: Implement authenticated review API

Implement strict JSON contracts and cursor pagination:

```text
GET  /v1/review/tasks
POST /v1/review/tasks/{id}/approve
POST /v1/review/tasks/{id}/reject
POST /v1/review/tasks/{id}/merge-subject
POST /v1/review/tasks/{id}/resolve-url
```

All routes require the private token. Mutation bodies include expected version and bounded reason. Return 409 for stale versions, 422 for policy-invalid actions, and safe 404s. Merge operations must preserve aliases, evidence edges, and a reversible audit record; never delete the losing subject row outright.

**Verify**: Hono `app.request` and PostgreSQL integration tests cover auth, pagination, happy paths, stale writes, invalid merge, URL candidate membership, and audit response redaction.

### Step 6: Materialize seed results and measure dedup/review load

Run materialization against the validated seed shadow results. Create an adjudicated subject-pair fixture from all proposed merges and calculate dedup precision/recall. Report task counts by reason and priority so review workload is visible.

Required gates: subject-dedup precision ≥ 0.97 and recall ≥ 0.90. Do not lower precision to improve recall; uncertain matches stay separate and reviewed.

**Verify**: `npm run evaluation:subjects` meets both gates and writes a versioned report; `npm run review:stats -- --corpus seed-v1` returns counts without source bodies.

## Test plan

- URL normalization and allowed tracking-parameter removal.
- Subject identity/dedup matrix, including homonyms and root-only repetitions.
- Materialization idempotency and evidence provenance.
- Review reason/priority table.
- Review transition/concurrency/audit integration tests.
- API auth, strict bodies, cursor pagination, status codes, and redaction.
- Seed subject-dedup metrics and review-load report.

## Done criteria

- [ ] Migrations 0004 and 0005 apply cleanly from an empty DB.
- [ ] Every discovery/note/mention traces to a classification run and evidence spans.
- [ ] Name-only matches never auto-merge.
- [ ] Root-only duplicate discoveries collapse correctly.
- [ ] Review policy covers every mandatory reason from the research plan.
- [ ] Review mutations are authenticated, optimistic, idempotent, and audited.
- [ ] Dedup precision ≥ 0.97 and recall ≥ 0.90.
- [ ] Global verification/evaluation gates pass and Plan 004 is `DONE`.

## STOP conditions

- Plan 003 metrics no longer pass.
- Subject identity requires external-page fetching to work acceptably.
- A proposed merge cannot preserve all evidence/provenance/audit history.
- Review authentication requires exposing the private token to logs or checked-in files.
- Dedup precision is below 0.97 on the adjudicated fixture.

## Maintenance notes

Subject identity changes are migration-level behavior: bump the dedup/extraction version and re-evaluate rather than silently recomputing existing identities. Reviewers should focus on accidental auto-merges, evidence loss, and un-audited mutation paths.
