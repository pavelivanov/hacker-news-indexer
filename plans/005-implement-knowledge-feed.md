# Plan 005: Implement the private knowledge-feed APIs and reconciliation

> **Executor instructions**: Complete Plan 004 first. Serve only approved or policy-auto-approved objects and preserve provenance in every response. Update Plan 005 in `plans/README.md` only after diversity, tombstone, pagination, and performance gates pass.
>
> **Drift check (run first)**: verify Plans 001–004 are `DONE`; run the seed replay, evaluation suite, and subject-dedup evaluation. Stop if any prior acceptance gate has regressed.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/004-implement-subjects-and-review.md`
- **Category**: feature / performance / operations
- **Planned at**: unborn repository with no `HEAD`, 2026-08-24

## Why this matters

This plan turns reviewed data into the actual product: a private technical-note and discovery feed with subject pages, story clusters, stable pagination, safe rendering, and deletion/edit reconciliation. It also prevents a few repeated HN stories from dominating the reader.

## Current state expected from dependencies

- Canonical comments/roots, validated classifications, subjects, discoveries, expert notes, review tasks, and audit history exist.
- No reader API, ranking/diversity policy implementation, reconciliation scheduler, or production metrics exist.
- Two roots account for 20.4% of the seed comments; the first 20 feed positions may contain at most two items from one root.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Feed tests | `npm test -- --run tests/unit/feed tests/unit/ranking` | all pass |
| Reader integration | `npm run test:integration -- --run tests/integration/reader-api.test.ts` | all pass |
| Reconciliation | `npm run test:integration -- --run tests/integration/reconciliation.test.ts` | all pass |
| Seed feed audit | `npm run feed:audit -- --corpus seed-v1` | first-20 root cap ≤ 2; no provenance gaps |
| Pipeline benchmark | `npm run benchmark:pipeline -- --fixture seed-v1` | p95 < 60s/comment excluding deferred upstream failures |

## Scope

**In scope**:

- `packages/application/src/{rank,serve-feed,serve-subject,serve-comment,serve-story,reconcile-hn}.ts`.
- Feed/story/provenance contracts in `packages/contracts/src`.
- Reader and metrics routes under `apps/api/src/routes`.
- Reconciliation/schedule jobs under `apps/worker/src/jobs`.
- Query repositories/indexes that do not change entity semantics.
- Structured logging/metrics modules and tests.
- Reader API, ranking, pagination, tombstone, reconciliation, and benchmark fixtures/tests.

**Out of scope**:

- Frontend, public multi-user auth, personalization, user voting/comments.
- External-page fetching.
- FindThatProject export.
- Full-text/vector search in v1; database-backed filters and subject lookup are sufficient.
- Multi-region or horizontal scaling.

## Git workflow

- Branch: `codex/005-knowledge-feed`.
- Commit query/read contracts separately from reconciliation/observability.
- Do not push or deploy without instruction.

## Steps

### Step 1: Define versioned reader contracts

Add strict response contracts for:

```text
GET /v1/feed?kind=discovery|expert_note&cursor=...
GET /v1/comments/{hn_comment_id}
GET /v1/stories/{hn_story_id}
GET /v1/subjects/{subject_id}
GET /v1/subjects/{subject_id}/notes
```

Every item includes stable ID, kind/status, bounded title/summary, subject links, selected-comment ID, resolved-root ID, displayed-story ID when present, source occurrence IDs, evidence origin/spans or safe excerpts, timestamps, and review/publication revision. Do not expose raw classifier output, prompts, tokens, session data, internal errors, or unredacted URL queries.

All `/v1` endpoints remain bearer-authenticated because this is a private single-user tool. Health endpoints remain unauthenticated.

**Verify**: contract snapshot tests reject missing provenance and unknown fields; auth/404 behavior is consistent.

### Step 2: Implement stable candidate ordering and story diversity

Rank canonical discoveries/notes, never Telegram occurrences. Start with a transparent versioned policy:

1. filter to approved/policy-auto-approved, available content;
2. order by publication time descending, then confidence descending, then stable entity ID;
3. apply story saturation `1 / sqrt(1 + prior_items_from_story)` when selecting among the current candidate window;
4. allow at most two items from one root in the first 20 positions;
5. move extra same-root items behind a story cluster, not out of storage;
6. root-story-only discovery appears once per `(root_id, subject_dedup_key, extraction_version)`.

Use a versioned opaque cursor containing the rank version and final stable sort tuple; sign or validate it so malformed cursors fail with 400. Do not use offset pagination.

**Verify**: table/property tests cover empty feed, all-one-root, two ten-comment roots, ties, insertion between pages, no duplicates/skips, multipart collapse, and cap ≤ 2 in first 20.

### Step 3: Implement reader queries and story/subject clusters

Use bounded, indexed queries that avoid N+1 access. Batch provenance, evidence, and subject edges. Subject pages aggregate notes/discoveries without treating note summaries as canonical project descriptions. Story pages show the root plus selected approved items; never query siblings from HN.

Return sanitized HN HTML only from the canonical sanitizer output. External links include `noopener`, `noreferrer`, and `nofollow`; only `http`/`https` survive.

**Verify**: integration tests assert response shape, query-count ceiling for a 20-item page, no unapproved/deleted content, correct subject/story clustering, and safe link attributes.

### Step 4: Add HN edit/deletion/root reconciliation

Implement `RECONCILE_HN_ITEM` jobs that refetch stored selected comments and their parent chains on a configurable schedule. Compare hashes because HN exposes no edit timestamp. Preserve historical resolution paths and create a new current path when reparented.

On changed content: store the new canonical revision, supersede affected active classification/materialization, enqueue reclassification, and create review tasks for divergence. On deleted/dead/flagged content: stop serving the body, retain only ID/status/non-reversible hashes and required audit metadata, and retract publication eligibility. Never reconstruct deleted text from archives.

Use idempotent schedules and an advisory-lock/singleton mechanism so only one scheduler enqueues a given period.

**Verify**: reconciliation tests cover unchanged, edited, reparented, deleted, dead, flagged, retryable failure, and repeated runs. Deleted body is absent from API and logs after reconciliation.

### Step 5: Add structured observability without sensitive payloads

Implement JSON logs with correlation/run/job/entity IDs, stage, state, duration, retry count, and error code. Add the research metrics:

`ingestion_messages_total`, `ingestion_gap_total`, `hn_resolution_depth`, `hn_cache_hit_total`, `displayed_root_mismatch_total`, `multipart_incomplete_total`, `classification_total`, `classification_schema_error_total`, `classification_latency_seconds`, `url_candidate_rejected_total`, `review_queue_depth`, `review_queue_oldest_age_seconds`, `feed_root_concentration`, `export_total`, and `pipeline_failure_total`.

Protect `/metrics` with the private token or expose it only on Railway private networking. Add a regression test that scans captured logs for fixture comment bodies, prompts, credentials, session strings, database URLs, and URL query values.

**Verify**: observability tests prove required metrics change on fixture events and sensitive markers never appear.

### Step 6: Audit seed serving and performance

Materialize a feed from the seed corpus and generate a machine-readable audit: item counts by kind/status, provenance completeness, root concentration, first-20 cap, cluster counts, review exclusions, and tombstones. Benchmark the end-to-end worker path using replayed/fake classifier responses.

Required gates: no provenance gaps, first-20 same-root ≤ 2, no unapproved/deleted bodies, and pipeline p95 under 60 seconds/comment excluding explicitly deferred upstream failures.

**Verify**: feed audit and benchmark commands meet every gate; the global verification suite passes.

## Test plan

- Reader contract/provenance/schema snapshots.
- Ranking/diversity property tests and stable keyset pagination.
- Batched-query/N+1 integration assertion.
- Sanitized rendering/link safety.
- Edit/reparent/delete/dead/flag reconciliation state transitions.
- Scheduler idempotency/singleton behavior.
- Metrics and log-redaction tests.
- Seed feed audit and pipeline benchmark.

## Done criteria

- [ ] All reader endpoints are authenticated, versioned, bounded, and provenance-complete.
- [ ] Same-root items in first 20 are never above two.
- [ ] Multipart and root-only duplicates do not create repeated cards.
- [ ] Unapproved/deleted content is not served.
- [ ] Reconciliation preserves history while updating current state.
- [ ] Metrics exist and logs contain no sensitive/source payloads.
- [ ] Pipeline p95 is under 60 seconds/comment under the defined benchmark.
- [ ] Global gates pass and Plan 005 is `DONE`.

## STOP conditions

- Any reader object cannot be traced to a selected comment and evidence.
- Meeting diversity requirements would require deleting or hiding data rather than clustering it.
- Reconciliation cannot remove deleted bodies without destroying required audit references.
- Feed performance requires external search infrastructure or Redis at current personal scale.
- A metrics/logging library serializes secrets or source bodies by default and cannot be safely configured.

## Maintenance notes

Rank policy and cursor format are versioned contracts. Changing them requires pagination/diversity regression tests and either cursor compatibility or an explicit version reset. Reconciliation changes must be reviewed for accidental body retention and repeated reclassification loops.
