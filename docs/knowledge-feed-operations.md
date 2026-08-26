# Knowledge feed operations

The reader is private. Supply `Authorization: Bearer $APP_API_TOKEN` to every `/v1/*` request and to `/metrics`; `/health/live` and `/health/ready` remain public.

## Reader endpoints

- `GET /v1/feed?kind=discovery|expert_note&cursor=...`
- `GET /v1/comments/{hn_comment_id}`
- `GET /v1/stories/{hn_story_id}`
- `GET /v1/subjects/{subject_id}`
- `GET /v1/subjects/{subject_id}/notes?cursor=...`

Feed cursors are signed, versioned, and scoped to one feed or subject. A malformed, modified, or cross-scope cursor returns `400`. The first 20 primary cards contain at most two items from one resolved root; additional cards remain available under `story_clusters`.

Only the active approved decision for an available selected comment and available resolved root is readable. Reader responses omit classifier payloads, prompts, usage, internal failures, source bodies, and URL queries. HN HTML is allowlisted; links are restricted to HTTP(S) and rendered with `noopener noreferrer nofollow`.

## Reconciliation

Schedule a bounded daily batch with an idempotent key:

```sh
npm run reconcile:schedule -- --key 2026-08-26 --limit 10000
```

The scheduler takes a PostgreSQL advisory transaction lock and creates at most one `RECONCILE_HN_ITEM` job per selected comment and key. Run the same command safely after an interrupted scheduler; existing jobs are not duplicated.

Reconciliation compares HN response and canonical hashes, appends item/comment/path revisions, and updates the current path when a comment is reparented. Changed classifier context clears the active decision, supersedes affected materializations, opens a divergence review, and enqueues classification. Deleted, dead, or missing selected comments have current and historical bodies scrubbed and immediately become ineligible for reader APIs. The system never restores deleted bodies from archives.

## Audit and benchmark

After seed replay and shadow materialization, run:

```sh
npm run feed:audit -- --corpus seed-v1
npm run benchmark:pipeline -- --fixture seed-v1
```

Both commands emit one machine-readable JSON object and exit nonzero on a failed gate. The feed audit reports materialized/served counts, statuses, provenance gaps, root concentration, first-20 saturation, clusters, review exclusions, and tombstones. With the mandatory-review shadow corpus, an empty served feed is expected until explicit approvals exist. The benchmark rebuilds and validates the stored classifier input/output path for each available selected comment; deferred upstream records are reported separately and the completed-comment p95 gate is 60 seconds.

## Metrics and logs

Scrape `GET /metrics` with the private token. The endpoint refreshes review-queue depth/age and exposes the required metric families. Worker-local pipeline metrics are wired at their event sources; deployment-level collection is completed in Plan 007. Do not expose the endpoint publicly without bearer authentication or private-network enforcement.

Plan 006 activates `export_total` after a successful FindThatProject outbox
acknowledgement. See `docs/findthatproject-export-operations.md` for the
separate reviewer/consumer credentials, non-mutating validation, and manual
approval flow.

Logs are JSON and intentionally limited to correlation/run/job/entity IDs, stage, state, durations, retry counts, and stable error codes. Never add comment/root bodies, HTML, prompts, provider output, credentials, sessions, database URLs, or raw URLs to log fields.
