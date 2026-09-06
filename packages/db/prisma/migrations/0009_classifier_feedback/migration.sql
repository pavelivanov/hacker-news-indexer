CREATE TABLE "classifier_result_snapshots" (
  "run_id" UUID PRIMARY KEY REFERENCES "classification_runs"("id") ON DELETE RESTRICT,
  "source_input" JSONB NOT NULL,
  "original_output" JSONB,
  "error_code" TEXT,
  "category" TEXT NOT NULL CHECK ("category" IN ('DISCOVERY','EXPERT_NOTE','REJECTED','REVIEW','FAILED')),
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "feedback_version" INTEGER NOT NULL DEFAULT 0 CHECK ("feedback_version" >= 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "classifier_result_snapshots_category_created_at_run_id_idx"
ON "classifier_result_snapshots"("category", "created_at", "run_id");
CREATE TABLE "classifier_feedback" (
  "id" UUID PRIMARY KEY,
  "result_id" UUID NOT NULL REFERENCES "classifier_result_snapshots"("run_id") ON DELETE RESTRICT,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "command_key" TEXT NOT NULL UNIQUE,
  "request_hash" TEXT NOT NULL,
  "values" JSONB NOT NULL,
  "actor_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("result_id", "version")
);
CREATE FUNCTION preserve_classifier_snapshot() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.run_id, NEW.source_input, NEW.original_output, NEW.error_code, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.run_id, OLD.source_input, OLD.original_output, OLD.error_code, OLD.created_at) THEN
    RAISE EXCEPTION 'classifier source and original output are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER classifier_snapshot_immutable BEFORE UPDATE ON "classifier_result_snapshots"
FOR EACH ROW EXECUTE FUNCTION preserve_classifier_snapshot();
CREATE FUNCTION preserve_classifier_feedback() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'classifier feedback is append only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER classifier_feedback_immutable BEFORE UPDATE OR DELETE ON "classifier_feedback"
FOR EACH ROW EXECUTE FUNCTION preserve_classifier_feedback();
