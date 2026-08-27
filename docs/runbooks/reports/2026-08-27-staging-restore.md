# Staging PostgreSQL restore drill — 2026-08-27

## Result

**PASSED WITH FOLLOW-UP.** A PostgreSQL 18 logical backup was streamed directly
through `age`, restored into a private disposable staging database, and checked
through SQL plus a private matching API deployment. The active staging database
and services were not modified. Production remained empty.

The remaining follow-up is to copy the dedicated recovery identity to an
owner-controlled offline or password-manager location. This drill proves the
current local encrypted artifact can be restored; it does not yet prove recovery
after loss of the operator's machine.

## Scope and identity

- Operator: repository owner with Codex execution.
- Railway CLI: `5.45.2`.
- Environment: `staging`; production service count remained zero.
- Source database: `postgres`, service ID suffix `c433`, deployment ID suffix
  `ea40`, PostgreSQL `18.6`.
- Source application: main commit `98b9507`; the restore API used a checkout
  with identical application code plus documentation-only commit `3785b18`.
- Scratch database: generated service `Postgres`, service ID suffix `24a4`,
  PostgreSQL `18.6`, private domain count zero.
- Scratch API: `api-restore-20260827`, service ID suffix `ef22`, private domain
  count zero, worker/scheduler/Telegram/classifier/export activation absent.

Full service, deployment, volume, and backup IDs remain outside Git.

## Backup evidence

- Encrypted artifact:
  `~/Backups/hacker-news-indexer/2026-08-27-staging-postgres-verified.dump.age`.
- Encryption: `age` `1.3.1`, dedicated X25519 recovery identity outside the
  repository, identity and artifact modes `0600`.
- Plaintext-on-disk count: zero; `pg_dump` streamed directly into `age`.
- Backup start: 2026-08-27 13:57:41 UTC.
- Backup end: 2026-08-27 13:57:46 UTC.
- Encrypted size: 137,656 bytes.
- Decrypted `pg_restore --list` catalog entries: 303.
- Dump/restore tools: PostgreSQL `18.6`, matching the source and target major.

An initial artifact encrypted to an existing passphrase-protected SSH key could
not be verified non-interactively because `age` cannot use the SSH agent for
decryption. It was superseded by the dedicated recovery identity and selected
for deletion after this report was created.

## Restore and integrity evidence

- Scratch service ready: 2026-08-27 13:58:25 UTC.
- Restore start: 2026-08-27 14:00:00 UTC.
- Restore end: 2026-08-27 14:00:06 UTC.
- `pg_restore` options: `--exit-on-error --no-owner --no-acl`.
- Restored application table counts matched the source exactly: zero rows in
  `ingestion_runs`, `selection_occurrences`, `hn_items`, `selected_comments`,
  `classification_runs`, `review_tasks`, `subjects`, `discoveries`,
  `expert_notes`, and `export_outbox`.
- Pipeline-job and review-task state counts matched the empty source.
- Unvalidated foreign keys: zero.
- Applied, non-rolled-back migrations: nine:
  `0001_ingestion`, `0002_hn_resolution`, `0003_classification`,
  `0004_classification_input_token_details`,
  `0005_queue_available_at_precision`, `0005_review`,
  `0005_subjects_and_notes`, `0006_knowledge_feed`, and
  `0007_findthatproject_export`.

## Application verification

The matching API was deployed without a public domain and probed through
Railway SSH only:

- `GET /healthz`: `200`, `status=ok`.
- `GET /readyz`: `200`, `status=ok` against the restored database.
- Unauthenticated `GET /v1/feed?kind=discovery`: `401`, `unauthorized`.
- Private in-process authenticated discovery feed: `200`, zero items.
- Bounded runtime logs contained only redacted configuration and startup
  metadata; no token, database URL, source body, prompt, payload, or private URL
  was observed.
- The active staging API's secret-safe smoke passed after the drill.
- Verification end: 2026-08-27 14:10:47 UTC.

## RPO and RTO observations

- Observed logical-backup capture time: 5 seconds.
- Observed database restore time: 6 seconds.
- Observed scratch-service creation through full API verification: 12 minutes
  22 seconds.
- Total backup-start through verification time: 13 minutes 6 seconds, within
  the initial four-hour RTO target.
- The source was quiescent and contained zero application rows, so the observed
  RPO at capture was effectively zero. This does not demonstrate RPO under
  concurrent writes; repeat the drill after staging contains representative
  data.

## Deviations and follow-ups

- Railway CLI `5.45.2` ignored the requested disposable database name and
  created `Postgres`; every restore command therefore used the exact service ID.
- A service-rename API attempt returned no error but was a no-op.
- The first repository-created scratch API deployment selected a stale default
  branch despite `--branch main`. It remained private, was rejected as evidence,
  and was removed. Direct checkout upload produced the accepted Dockerfile
  deployment.
- `railway down` removed the stale active deployment rather than the newest
  queued duplicate. Both remaining correct deployments belonged only to the
  disposable service selected for deletion.
- Copy the dedicated recovery identity from
  `~/.config/hacker-news-indexer/recovery-age-key.txt` to an approved offline or
  password-manager location. Never commit or transmit its contents in logs.
- Repeat with representative non-empty staging data and an off-machine copy of
  the encrypted artifact before production promotion.

## Cleanup decision

The owner's instruction to process the recommended short-lived restore drill
included cleanup after verification. Delete the exact scratch API and database
services after this report exists, read back staging/production state, and then
record the deletion result below.

Cleanup completed at 2026-08-27 14:13 UTC:

- The scratch API and database services are absent from staging readback.
- The scratch volume is unattached and marked `isPendingDeletion=true`; Railway
  reports its platform deletion timestamp as 2026-08-29 14:13 UTC.
- The original API, worker, scheduler, and PostgreSQL services remain
  `SUCCESS`; the original PostgreSQL and Telegram volumes remain `READY`.
- Production still contains zero services.
- The superseded SSH-recipient artifact was deleted. It is not recoverable from
  the filesystem; the verified dedicated-identity artifact remains intact.

Cleanup status: **COMPLETE — PLATFORM VOLUME DELETION PENDING**.
