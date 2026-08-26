# FindThatProject export operations

The integration is a private, pull-only transactional outbox. This service
never calls FindThatProject and does not authorize downstream mutation. Every
initial `UPSERT` requires a separate human export approval. Corrections and
retractions are appended as immutable revisions under the same `export_id`.

## Credentials and endpoints

Configure two different secrets:

- `APP_API_TOKEN` authenticates the reviewer endpoints.
- `EXPORT_CONSUMER_TOKEN` authenticates only pull and acknowledgement.

Startup rejects equal non-empty values. Do not put either token in URLs, logs,
command keys, reasons, or idempotency keys.

Reviewer endpoints:

- `POST /v1/exports/findthatproject/candidates/{discovery_id}/review`
- `POST /v1/exports/findthatproject/reviews/{task_id}/approve`

Consumer endpoints:

- `GET /v1/exports/findthatproject/outbox?cursor=...&limit=...`
- `POST /v1/exports/findthatproject/outbox/{export_id}/revisions/{revision}/ack`

The consumer limit defaults to 25 and is bounded to 1–100. Cursors are signed
and scoped to this outbox. An acknowledgement must repeat the exact payload
hash returned by pull and provide a stable idempotency key.

## Local non-mutating verification

Run the contract and sealed holdout checks before reviewing live candidates:

```sh
npm run test:contract -- --target findthatproject --dry-run
npm run export:audit -- --corpus holdout-v1
```

The contract command validates only the approved local fixture. It performs no
network request. The audit reads the sealed Sol holdout report, requires at
least 0.98 precision, zero false-positive exports, full URL grounding, and no
activated model decisions, then writes
`evaluation/reports/export-audit-holdout-v1.json`.

## Manual reviewer flow

Start PostgreSQL, apply migrations, and start the API with both credentials in
the environment:

```sh
docker compose up -d postgres
npm run db:test:wait
npm run db:migrate:deploy
npm run dev:api
```

Use an approved Discovery ID from `GET /v1/feed?kind=discovery`. Before opening
the export review, inspect its summary, subject type and canonical URL, every
evidence excerpt, the selected HN comment, and the resolved root. Confirm that
the comment materially discusses the named subject and that the canonical URL
is actually present in the supplied HN evidence. Do not infer or repair a URL
from an external page.

In a second shell, set local placeholders without printing either token:

```sh
API_BASE=http://127.0.0.1:3000
DISCOVERY_ID=replace-with-discovery-uuid
```

Open an export-purpose review with the reviewer credential:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer ${APP_API_TOKEN}" \
  -H "Content-Type: application/json" \
  "${API_BASE}/v1/exports/findthatproject/candidates/${DISCOVERY_ID}/review" \
  -d '{"command_key":"ftp-review-001","reason":"Manually inspected subject, URL, provenance, and evidence"}'
```

Record `task_id` and `version` from the response. Reinspect the candidate if
anything changed, then approve that exact snapshot:

```sh
TASK_ID=replace-with-review-task-uuid
TASK_VERSION=1
curl -fsS -X POST \
  -H "Authorization: Bearer ${APP_API_TOKEN}" \
  -H "Content-Type: application/json" \
  "${API_BASE}/v1/exports/findthatproject/reviews/${TASK_ID}/approve" \
  -d "{\"expected_version\":${TASK_VERSION},\"command_key\":\"ftp-approve-001\",\"reason\":\"Approved the unchanged reviewed export snapshot\"}"
```

Approval and immutable outbox insertion commit in one serializable database
transaction. A changed snapshot, unresolved review flag, missing provenance,
unavailable HN item, confidence below 0.95, disallowed type, or ungrounded URL
fails closed. Reusing a command key is safe only with the identical request.

## Manual consumer flow

Pull with the dedicated consumer credential. The reviewer credential must
return `401` here:

```sh
curl -fsS \
  -H "Authorization: Bearer ${EXPORT_CONSUMER_TOKEN}" \
  "${API_BASE}/v1/exports/findthatproject/outbox?limit=25"
```

Validate `payload` against `findthatproject.discovery.v1`, process the action
idempotently in the consumer, and retain `export_id`, `revision`, and
`payload_hash`. A local/manual verification should stop before any downstream
write. Only acknowledge after the consumer's own processing succeeds:

```sh
EXPORT_ID=replace-with-export-uuid
REVISION=1
PAYLOAD_HASH=replace-with-returned-sha256
curl -fsS -X POST \
  -H "Authorization: Bearer ${EXPORT_CONSUMER_TOKEN}" \
  -H "Content-Type: application/json" \
  "${API_BASE}/v1/exports/findthatproject/outbox/${EXPORT_ID}/revisions/${REVISION}/ack" \
  -d "{\"payload_hash\":\"${PAYLOAD_HASH}\",\"idempotency_key\":\"ftp-ack-${EXPORT_ID}-${REVISION}\"}"
```

Repeating the identical acknowledgement returns `replayed: true`. A hash or
idempotency mismatch returns `409`, and an old acknowledgement never covers a
new revision. Acknowledged revisions disappear from pending pull results.

## Retractions and audit evidence

HN reconciliation automatically appends a `RETRACT` revision if exported
source content changes or becomes unavailable. Other corrections and
rejections must also append revisions; never update or delete an earlier
payload. The database rejects mutation or deletion of export history.

For an operational check, verify that `export_total` increments only after a
successful acknowledgement and that logs contain request/entity identifiers
and safe error codes, never credentials, URLs, evidence text, or payloads.
