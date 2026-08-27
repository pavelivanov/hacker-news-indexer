# PostgreSQL backup and restore runbook

Railway platform backups and an owner-controlled encrypted logical backup are
independent recovery layers. Neither is considered working until a restore into
a disposable staging database passes integrity checks.

## Recovery objectives

Record actual observations after the first drill. Initial targets for this
personal service are RPO no greater than 24 hours and RTO no greater than four
hours. Tighten them only after measured restores and cost review.

Current status: **LOGICAL RESTORE DRILL PASSED — the 2026-08-27 encrypted
logical backup restored into an isolated PostgreSQL 18 service, matched source
counts/migrations/foreign-key state, and passed private API readiness and read
checks. PITR and Railway backup schedules remain disabled; offline recovery-key
retention and a representative non-empty-data drill remain follow-ups**.

The dated evidence is in
[`reports/2026-08-27-staging-restore.md`](reports/2026-08-27-staging-restore.md).

## Read-only recovery preflight

Railway CLI `5.45.1` exposes PostgreSQL recovery status without printing the
database URL. Resolve the project/environment first, then run:

```sh
railway status --json
railway postgres pitr status --service postgres --environment staging --json
railway postgres pitr schedule list --service postgres --environment staging --json
railway postgres pitr backup list --service postgres --environment staging --json
```

The 2026-08-27 staging preflight returned `enabled=false`,
`bucketWired=false`, an empty schedule list, and an empty backup list. These
commands were read-only. Enabling PITR, setting a schedule, creating or locking
a backup, and restoring into a sibling service are remote mutations that each
require the recovery-drill authorization gate in `deploy.md`.

The operator then authorized the lower-cost logical path without PITR. The
completed drill streamed `pg_dump` directly through `age`, restored it into a
private scratch database, verified it through SQL and a private API, and
removed the scratch services. Railway retained the unattached scratch volume
as pending deletion until its platform deletion timestamp.

## Railway backup/PITR checklist

After the database is authorized and created, inspect the Railway dashboard and
record without screenshots containing connection data:

- Plan/tier and whether backups or PITR are available.
- Backup schedule, retention window, region, and latest successful backup.
- Restore granularity and whether restore creates a new service/database.
- Owner access and billing impact.

Do not assume a managed Postgres service includes a particular retention or
PITR window. Re-check it before every production launch and quarterly.

## Encrypted logical backup

Prerequisites: authenticated Railway CLI, an explicit project/environment,
`age` with the owner's recovery recipient, enough private local disk, and a
stopped schema-changing deployment. Prefer `pg_dump` from the managed Postgres
container so the client/server major versions match.

1. Record start time, source environment, database deployment ID, current app
   commit, and latest migration name.
2. Stream a custom-format dump over Railway SSH into a mode-`0600` temporary
   file. The remote shell expands `DATABASE_URL`; do not print it:

   ```sh
   umask 077
   railway ssh --service postgres --environment production sh -lc 'pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL"' > backup.dump
   ```

3. Confirm `backup.dump` is non-empty, then encrypt it to the owner's offline
   recipient:

   ```sh
   age --recipient "${BACKUP_AGE_RECIPIENT}" --output backup.dump.age backup.dump
   ```

4. Verify the encrypted file can be listed/decrypted by the recovery identity
   in a private environment. Remove the plaintext file only after verification.
5. Store the encrypted artifact and its non-secret metadata in the approved
   owner-controlled retention location. Do not commit either file.

Never pass `DATABASE_URL`, passwords, or session credentials on a command line
or into a filename. Do not upload an unencrypted dump to cloud storage.

## Restore drill into disposable staging

Creating the disposable database and restoring data are remote/destructive
operations and require drill approval.

1. Create a new staging Postgres service named for the drill date. Never target
   the active staging or production database.
2. Confirm it is empty and private. Record its exact service ID outside Git.
3. Stream the decrypted custom dump to `pg_restore` inside that service:

   ```sh
   age --decrypt backup.dump.age | railway ssh --service <restore-service> --environment staging sh -lc 'pg_restore --exit-on-error --no-owner --no-acl --dbname="$DATABASE_URL"'
   ```

4. Connect through Railway's SSH tunnel and run the integrity queries below.
5. Deploy the matching known-good API release against the restored database,
   with worker, scheduler, Telegram, classifier, and export disabled.
6. Verify `/readyz`, authenticated read endpoints, and bounded read-only audits.
7. Record RPO/RTO and results. Delete the disposable service only after the
   report is complete and the operator approves deletion.

## Integrity queries

Run with `ON_ERROR_STOP=1`. These queries return counts and identifiers only;
they do not print source bodies, prompts, payloads, tokens, or URLs.

```sql
SELECT 'ingestion_runs' AS table_name, count(*) FROM ingestion_runs
UNION ALL SELECT 'selection_occurrences', count(*) FROM selection_occurrences
UNION ALL SELECT 'hn_items', count(*) FROM hn_items
UNION ALL SELECT 'selected_comments', count(*) FROM selected_comments
UNION ALL SELECT 'classification_runs', count(*) FROM classification_runs
UNION ALL SELECT 'review_tasks', count(*) FROM review_tasks
UNION ALL SELECT 'subjects', count(*) FROM subjects
UNION ALL SELECT 'discoveries', count(*) FROM discoveries
UNION ALL SELECT 'expert_notes', count(*) FROM expert_notes
UNION ALL SELECT 'export_outbox', count(*) FROM export_outbox
ORDER BY table_name;

SELECT state, count(*) FROM pipeline_jobs GROUP BY state ORDER BY state;
SELECT state, count(*) FROM review_tasks GROUP BY state ORDER BY state;

SELECT conname
FROM pg_constraint
WHERE contype = 'f' AND NOT convalidated;

SELECT migration_name, finished_at
FROM _prisma_migrations
WHERE rolled_back_at IS NULL
ORDER BY finished_at;
```

The unvalidated-foreign-key query must return zero rows. Compare counts and the
migration list to the source backup record; explain every difference.

## Drill report

Create `docs/runbooks/reports/YYYY-MM-DD-staging-restore.md` only after a real
drill. Include source/restore environment, redacted service/deployment ID
suffixes, backup start/end, restore start/end, latest source record time,
observed RPO/RTO, count comparison, FK/migration results, API read smoke,
cleanup decision, failures, and follow-ups.

Never claim recovery is complete based only on `pg_dump` exit status.
