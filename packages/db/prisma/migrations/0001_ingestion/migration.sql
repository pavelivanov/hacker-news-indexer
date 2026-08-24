CREATE TYPE "SelectionSource" AS ENUM ('TELEGRAM', 'FIXTURE');
CREATE TYPE "IngestionRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED');
CREATE TYPE "OccurrenceStatus" AS ENUM ('OBSERVED', 'MISSING', 'DELETED', 'RESOLVED', 'FAILED');
CREATE TYPE "HnReferenceRole" AS ENUM ('DISPLAYED_STORY_REFERENCE', 'SELECTED_COMMENT', 'INLINE_HN_REFERENCE');
CREATE TYPE "PipelineJobType" AS ENUM ('INGEST_SELECTION_RANGE', 'RESOLVE_HN_COMMENT');
CREATE TYPE "PipelineJobState" AS ENUM ('AVAILABLE', 'LEASED', 'COMPLETED', 'RETRYABLE', 'TERMINAL');

CREATE TABLE "ingestion_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "source" "SelectionSource" NOT NULL,
  "source_key" TEXT NOT NULL,
  "min_id" BIGINT NOT NULL,
  "max_id" BIGINT NOT NULL,
  "cursor" BIGINT,
  "request_key" TEXT NOT NULL,
  "code_version" TEXT NOT NULL DEFAULT 'development',
  "status" "IngestionRunStatus" NOT NULL DEFAULT 'PENDING',
  "observed_count" INTEGER NOT NULL DEFAULT 0,
  "resolved_count" INTEGER NOT NULL DEFAULT 0,
  "terminal_count" INTEGER NOT NULL DEFAULT 0,
  "failure_summary" TEXT,
  "started_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ingestion_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ingestion_runs_range_check" CHECK ("min_id" > 0 AND "max_id" >= "min_id")
);

CREATE TABLE "selection_occurrences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "source" "SelectionSource" NOT NULL,
  "source_key" TEXT NOT NULL,
  "external_id" BIGINT NOT NULL,
  "occurred_at" TIMESTAMPTZ(3),
  "edited_at" TIMESTAMPTZ(3),
  "content_hash" TEXT,
  "status" "OccurrenceStatus" NOT NULL DEFAULT 'OBSERVED',
  "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "selection_occurrences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "selection_occurrences_external_id_check" CHECK ("external_id" > 0)
);

CREATE TABLE "ingestion_run_occurrences" (
  "ingestion_run_id" UUID NOT NULL,
  "occurrence_id" UUID NOT NULL,
  "attached_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ingestion_run_occurrences_pkey" PRIMARY KEY ("ingestion_run_id", "occurrence_id")
);

CREATE TABLE "telegram_messages" (
  "occurrence_id" UUID NOT NULL,
  "entities" JSONB NOT NULL,
  "displayed_text_hash" TEXT,
  "body_snapshot" TEXT,
  "multipart_part" INTEGER,
  "multipart_total" INTEGER,
  "deleted" BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT "telegram_messages_pkey" PRIMARY KEY ("occurrence_id"),
  CONSTRAINT "telegram_messages_multipart_check" CHECK (
    ("multipart_part" IS NULL AND "multipart_total" IS NULL)
    OR ("multipart_part" > 0 AND "multipart_total" >= "multipart_part")
  )
);

CREATE TABLE "hn_references" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "occurrence_id" UUID NOT NULL,
  "hn_item_id" BIGINT NOT NULL,
  "role" "HnReferenceRole" NOT NULL,
  "entity_offset" INTEGER NOT NULL,
  "entity_length" INTEGER NOT NULL,
  "parse_confidence" DOUBLE PRECISION NOT NULL,
  CONSTRAINT "hn_references_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hn_references_item_check" CHECK ("hn_item_id" > 0),
  CONSTRAINT "hn_references_entity_check" CHECK ("entity_offset" >= 0 AND "entity_length" >= 0),
  CONSTRAINT "hn_references_confidence_check" CHECK ("parse_confidence" >= 0 AND "parse_confidence" <= 1)
);

CREATE TABLE "pipeline_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "ingestion_run_id" UUID,
  "type" "PipelineJobType" NOT NULL,
  "payload" JSONB NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "state" "PipelineJobState" NOT NULL DEFAULT 'AVAILABLE',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMPTZ(3),
  "last_error_code" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "pipeline_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pipeline_jobs_lease_check" CHECK (
    ("state" = 'LEASED' AND "lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL)
    OR "state" <> 'LEASED'
  )
);

CREATE UNIQUE INDEX "ingestion_runs_request_key_key" ON "ingestion_runs"("request_key");
CREATE INDEX "ingestion_runs_status_created_at_idx" ON "ingestion_runs"("status", "created_at");
CREATE UNIQUE INDEX "selection_occurrences_source_source_key_external_id_key" ON "selection_occurrences"("source", "source_key", "external_id");
CREATE INDEX "selection_occurrences_status_occurred_at_idx" ON "selection_occurrences"("status", "occurred_at");
CREATE UNIQUE INDEX "hn_references_occurrence_id_role_entity_offset_hn_item_id_key" ON "hn_references"("occurrence_id", "role", "entity_offset", "hn_item_id");
CREATE INDEX "hn_references_hn_item_id_idx" ON "hn_references"("hn_item_id");
CREATE UNIQUE INDEX "pipeline_jobs_idempotency_key_key" ON "pipeline_jobs"("idempotency_key");
CREATE INDEX "pipeline_jobs_state_available_at_created_at_idx" ON "pipeline_jobs"("state", "available_at", "created_at");
CREATE INDEX "pipeline_jobs_lease_expires_at_idx" ON "pipeline_jobs"("lease_expires_at");

ALTER TABLE "ingestion_run_occurrences" ADD CONSTRAINT "ingestion_run_occurrences_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ingestion_run_occurrences" ADD CONSTRAINT "ingestion_run_occurrences_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "selection_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "telegram_messages" ADD CONSTRAINT "telegram_messages_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "selection_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "hn_references" ADD CONSTRAINT "hn_references_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "selection_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pipeline_jobs" ADD CONSTRAINT "pipeline_jobs_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "ingestion_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
