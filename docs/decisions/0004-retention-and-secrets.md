# ADR 0004: Retention and secrets

- Status: accepted
- Date: 2026-08-24

## Decision

Retain Telegram occurrence IDs, entity and link data, timestamps, edit state, and non-reversible content hashes. By default, do not retain Telegram body text after successful canonical HN resolution. Retain canonical HN bodies while they are available, but remove them from serving after deletion or dead-content reconciliation and keep only identifiers, state, and non-reversible provenance hashes.

Telegram sessions, API credentials, classifier credentials, database credentials, and application tokens live outside the database, source tree, image, fixtures, and logs. Local session material must be protected and gitignored; production session storage must be encrypted or access-controlled.

## Consequences

Structured logs may contain bounded identifiers, stages, states, durations, and hashes. They must not contain source bodies, prompt bodies, session strings, credentials, stack traces returned to clients, or unredacted URL query values. A future retention job will implement deletion and reconciliation policy.
