# ADR 0006: FindThatProject export contract

- Status: Accepted by the downstream owner
- Date: 2026-08-26

## Context

FindThatProject must receive only reviewed, URL-grounded Discoveries. Direct
database coupling and downstream writes are outside this service's boundary.
The owner approved implementation and local validation of
`findthatproject.discovery.v1` in this task, with no downstream mutation
authorized.

## Decision

Use a private, pull-based transactional outbox. Every initial export requires a
dedicated human approval. Expert notes are structurally excluded. A consumer
uses a token distinct from the reviewer/API token, pulls immutable revisions,
and acknowledges the exact `export_id`, `revision`, and payload hash.

The v1 payload contains the approved research fields: immutable export and
Discovery identifiers, revision, bounded subject name/type/canonical URL and
evidence-based summary, HN comment/root IDs, Telegram message IDs, bounded HN
evidence, confidence, and review timestamp. It also contains the required
`action` discriminator:

- `UPSERT` creates or corrects the downstream representation.
- `RETRACT` removes eligibility without deleting or overwriting history.

Corrections and retractions append monotonically increasing revisions under the
same export ID. Previous payloads and acknowledgements are immutable. The
service will not call a mutating FindThatProject endpoint; the contract adapter
is dry-run and fixture-backed until separately authorized.

## Eligibility

Insertion fails closed unless the Discovery and selected/root HN items are
available, the active decision is manually approved, all confidence thresholds
are at least 0.95, the subject type is explicitly allowed, the canonical
HTTP(S) URL is a validated HN candidate, comment evidence materially discusses
the subject, no unresolved review flags remain, and the export-purpose review
is explicitly approved.

## Consequences

Payload changes require a new schema version. Delivery can be replayed safely,
and old acknowledgements cannot acknowledge later revisions. Downstream
compatibility is validated locally before any integration is enabled.
