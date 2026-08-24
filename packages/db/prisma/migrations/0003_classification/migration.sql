ALTER TYPE "PipelineJobType" ADD VALUE 'CLASSIFY_COMMENT';

CREATE TYPE "ClassificationRunStatus" AS ENUM ('SUCCEEDED', 'REVIEW', 'FAILED');
CREATE TYPE "ContentDecisionClass" AS ENUM ('DISCOVERY', 'EXPERT_NOTE', 'REJECTED', 'REVIEW');
CREATE TYPE "ContentDecisionSource" AS ENUM ('MODEL', 'MANUAL');
CREATE TYPE "EvidenceOrigin" AS ENUM ('COMMENT', 'ROOT_STORY');

CREATE TABLE "classification_runs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "comment_id" BIGINT NOT NULL,
  "input_hash" TEXT NOT NULL,
  "prompt_version" TEXT NOT NULL,
  "prompt_hash" TEXT NOT NULL,
  "schema_version" TEXT NOT NULL,
  "model_config_id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,
  "output_hash" TEXT,
  "provider_output" JSONB,
  "latency_ms" INTEGER,
  "input_tokens" INTEGER,
  "output_tokens" INTEGER,
  "status" "ClassificationRunStatus" NOT NULL,
  "error_code" TEXT,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "classification_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "classification_runs_latency_check" CHECK ("latency_ms" IS NULL OR "latency_ms" >= 0),
  CONSTRAINT "classification_runs_tokens_check" CHECK (("input_tokens" IS NULL OR "input_tokens" >= 0) AND ("output_tokens" IS NULL OR "output_tokens" >= 0)),
  CONSTRAINT "classification_runs_terminal_shape_check" CHECK (
    ("status" = 'FAILED' AND "error_code" IS NOT NULL) OR
    ("status" = 'SUCCEEDED' AND "error_code" IS NULL AND "output_hash" IS NOT NULL) OR
    ("status" = 'REVIEW' AND "output_hash" IS NOT NULL)
  )
);

CREATE TABLE "content_decisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "comment_id" BIGINT NOT NULL,
  "classification_run_id" UUID,
  "source" "ContentDecisionSource" NOT NULL,
  "primary_decision" "ContentDecisionClass" NOT NULL,
  "decision_confidence" DOUBLE PRECISION NOT NULL,
  "materially_technical" BOOLEAN NOT NULL,
  "review_required" BOOLEAN NOT NULL,
  "validated_output" JSONB NOT NULL,
  "manual_override_of_id" UUID,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "content_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "content_decisions_confidence_check" CHECK ("decision_confidence" >= 0 AND "decision_confidence" <= 1),
  CONSTRAINT "content_decisions_source_check" CHECK (
    ("source" = 'MODEL' AND "classification_run_id" IS NOT NULL AND "manual_override_of_id" IS NULL) OR
    ("source" = 'MANUAL' AND "classification_run_id" IS NULL AND "manual_override_of_id" IS NOT NULL)
  )
);

CREATE TABLE "evidence_spans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "content_decision_id" UUID NOT NULL,
  "span_id" TEXT NOT NULL,
  "source_document" TEXT NOT NULL,
  "origin" "EvidenceOrigin" NOT NULL,
  "start_offset" INTEGER NOT NULL,
  "end_offset" INTEGER NOT NULL,
  "text_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_spans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "evidence_spans_offsets_check" CHECK ("start_offset" >= 0 AND "end_offset" > "start_offset")
);

ALTER TABLE "selected_comments" ADD COLUMN "active_decision_id" UUID;

CREATE UNIQUE INDEX "classification_runs_comment_id_input_hash_prompt_version_schema_version_model_config_id_key"
  ON "classification_runs"("comment_id", "input_hash", "prompt_version", "schema_version", "model_config_id");
CREATE INDEX "classification_runs_comment_id_created_at_idx" ON "classification_runs"("comment_id", "created_at");
CREATE INDEX "classification_runs_status_created_at_idx" ON "classification_runs"("status", "created_at");
CREATE UNIQUE INDEX "content_decisions_classification_run_id_key" ON "content_decisions"("classification_run_id");
CREATE INDEX "content_decisions_comment_id_created_at_idx" ON "content_decisions"("comment_id", "created_at");
CREATE INDEX "content_decisions_manual_override_of_id_idx" ON "content_decisions"("manual_override_of_id");
CREATE UNIQUE INDEX "evidence_spans_content_decision_id_span_id_key" ON "evidence_spans"("content_decision_id", "span_id");
CREATE INDEX "evidence_spans_source_document_idx" ON "evidence_spans"("source_document");
CREATE UNIQUE INDEX "selected_comments_active_decision_id_key" ON "selected_comments"("active_decision_id");

ALTER TABLE "classification_runs" ADD CONSTRAINT "classification_runs_comment_id_fkey"
  FOREIGN KEY ("comment_id") REFERENCES "selected_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_decisions" ADD CONSTRAINT "content_decisions_comment_id_fkey"
  FOREIGN KEY ("comment_id") REFERENCES "selected_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_decisions" ADD CONSTRAINT "content_decisions_classification_run_id_fkey"
  FOREIGN KEY ("classification_run_id") REFERENCES "classification_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "content_decisions" ADD CONSTRAINT "content_decisions_manual_override_of_id_fkey"
  FOREIGN KEY ("manual_override_of_id") REFERENCES "content_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "evidence_spans" ADD CONSTRAINT "evidence_spans_content_decision_id_fkey"
  FOREIGN KEY ("content_decision_id") REFERENCES "content_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "selected_comments" ADD CONSTRAINT "selected_comments_active_decision_id_fkey"
  FOREIGN KEY ("active_decision_id") REFERENCES "content_decisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION prevent_classification_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'classification history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER classification_runs_append_only
  BEFORE UPDATE OR DELETE ON "classification_runs"
  FOR EACH ROW EXECUTE FUNCTION prevent_classification_history_mutation();
CREATE TRIGGER content_decisions_append_only
  BEFORE UPDATE OR DELETE ON "content_decisions"
  FOR EACH ROW EXECUTE FUNCTION prevent_classification_history_mutation();
CREATE TRIGGER evidence_spans_append_only
  BEFORE UPDATE OR DELETE ON "evidence_spans"
  FOR EACH ROW EXECUTE FUNCTION prevent_classification_history_mutation();
