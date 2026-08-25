-- Millisecond timestamp columns round CURRENT_TIMESTAMP and can place a newly
-- created job fractionally in the future. Preserve PostgreSQL's native
-- microsecond precision so immediate work is claimable without leasing
-- deliberately scheduled work early.
ALTER TABLE "pipeline_jobs"
  ALTER COLUMN "available_at" TYPE TIMESTAMPTZ(6);
