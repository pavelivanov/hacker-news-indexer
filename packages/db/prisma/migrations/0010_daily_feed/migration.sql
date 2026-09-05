ALTER TABLE "pipeline_jobs" ADD COLUMN "lane" TEXT NOT NULL DEFAULT 'legacy'
  CHECK ("lane" IN ('legacy', 'feed'));
CREATE INDEX "pipeline_jobs_lane_state_available_at_idx" ON "pipeline_jobs"("lane","state","available_at");
ALTER TABLE "classification_runs" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1 CHECK ("attempt" > 0);
DROP INDEX "classification_runs_comment_id_input_hash_prompt_version_schema_version_model_config_id_key";
CREATE UNIQUE INDEX "classification_runs_identity_attempt_key" ON "classification_runs"
  ("comment_id","input_hash","prompt_version","schema_version","model_config_id","attempt");
CREATE TABLE "feed_processing_state" (
  "id" TEXT PRIMARY KEY DEFAULT 'local' CHECK ("id" = 'local'),
  "source_key" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "cursor" BIGINT CHECK ("cursor" > 0),
  "sync_requested" BOOLEAN NOT NULL DEFAULT true,
  "next_sync_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_checked_at" TIMESTAMPTZ(3),
  "heartbeat_at" TIMESTAMPTZ(3),
  "error_code" TEXT,
  "interval_seconds" INTEGER NOT NULL DEFAULT 1800 CHECK ("interval_seconds" BETWEEN 60 AND 86400),
  "batch_size" INTEGER NOT NULL DEFAULT 20 CHECK ("batch_size" BETWEEN 1 AND 100),
  "daily_request_limit" INTEGER NOT NULL DEFAULT 100 CHECK ("daily_request_limit" BETWEEN 1 AND 1000),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "feed_sync_batches" (
  "run_id" UUID PRIMARY KEY REFERENCES "ingestion_runs"("id") ON DELETE CASCADE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "feed_request_usage" (
  "day" DATE PRIMARY KEY,
  "requests" INTEGER NOT NULL DEFAULT 0 CHECK ("requests" >= 0)
);
CREATE TABLE "feed_command_receipts" (
  "command_key" TEXT PRIMARY KEY,
  "request_hash" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
