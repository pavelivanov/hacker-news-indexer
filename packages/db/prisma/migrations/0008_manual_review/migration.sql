CREATE TABLE "manual_review_drafts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  "comment_id" BIGINT NOT NULL UNIQUE REFERENCES "selected_comments"("id") ON DELETE RESTRICT,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "source_hash" VARCHAR(64) NOT NULL CHECK ("source_hash" ~ '^[a-f0-9]{64}$'),
  "base_active_decision_id" UUID,
  "state" VARCHAR(16) NOT NULL DEFAULT 'DRAFT' CHECK ("state" IN ('DRAFT', 'APPROVED', 'REJECTED')),
  "actor_id" VARCHAR(128) NOT NULL CHECK (char_length("actor_id") > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CHECK (jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 131072)
);

ALTER TABLE "content_decisions" ADD COLUMN "manual_draft_id" UUID UNIQUE
  REFERENCES "manual_review_drafts"("id") ON DELETE RESTRICT;
ALTER TABLE "content_decisions" DROP CONSTRAINT "content_decisions_source_check";
ALTER TABLE "content_decisions" ADD CONSTRAINT "content_decisions_source_check" CHECK (
  ("source" = 'MODEL' AND "classification_run_id" IS NOT NULL AND "manual_override_of_id" IS NULL AND "manual_draft_id" IS NULL) OR
  ("source" = 'MANUAL' AND "classification_run_id" IS NULL AND
    ("manual_override_of_id" IS NOT NULL OR "manual_draft_id" IS NOT NULL) AND
    ("manual_draft_id" IS NULL OR "review_required"))
);

CREATE TABLE "manual_review_receipts" (
  "command_key" VARCHAR(160) NOT NULL PRIMARY KEY,
  "draft_id" UUID NOT NULL UNIQUE REFERENCES "manual_review_drafts"("id") ON DELETE RESTRICT,
  "request_hash" VARCHAR(64) NOT NULL,
  "result" JSONB NOT NULL
);

ALTER TABLE "review_tasks" DROP CONSTRAINT "review_tasks_reasons_check";
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_reasons_check" CHECK (
  cardinality("reason_codes") > 0 AND "reason_codes" <@ ARRAY[
    'PROMPT_INJECTION', 'DESTRUCTIVE_OR_EVASION_ADVICE', 'DELETED_OR_FLAGGED_CONTENT',
    'SECURITY_RECOMMENDATION', 'MEDICAL_RECOMMENDATION', 'LEGAL_RECOMMENDATION',
    'TELEGRAM_HN_DIVERGENCE', 'CONFLICTING_EVIDENCE_ORIGIN', 'FINDTHATPROJECT_INITIAL_ROLLOUT',
    'NAME_ONLY_MERGE_SUGGESTION', 'AMBIGUOUS_CANONICAL_URL', 'MISSING_CANONICAL_URL',
    'ROOT_ONLY_DISCOVERY', 'LOW_CONFIDENCE', 'AMBIGUOUS_CLASSIFICATION',
    'UNPROMOTED_MODEL_DECISION', 'MANUAL_DECISION_REVIEW'
  ]::TEXT[]
);

CREATE FUNCTION guard_manual_draft_update() RETURNS trigger AS $$
BEGIN
  IF OLD."state" <> 'DRAFT' OR NEW."version" <> OLD."version" + 1 OR
    NEW."id" <> OLD."id" OR NEW."comment_id" <> OLD."comment_id" OR
    NEW."base_active_decision_id" IS DISTINCT FROM OLD."base_active_decision_id" OR
    NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'invalid manual draft transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER manual_draft_update_guard BEFORE UPDATE ON "manual_review_drafts"
  FOR EACH ROW EXECUTE FUNCTION guard_manual_draft_update();

CREATE FUNCTION guard_manual_decision() RETURNS trigger AS $$
BEGIN
  IF NEW."manual_draft_id" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "manual_review_drafts" d
    WHERE d."id" = NEW."manual_draft_id" AND d."comment_id" = NEW."comment_id"
      AND d."base_active_decision_id" IS NOT DISTINCT FROM NEW."manual_override_of_id"
      AND d."state" = CASE WHEN NEW."primary_decision" = 'REJECTED' THEN 'REJECTED' ELSE 'APPROVED' END
  ) THEN RAISE EXCEPTION 'manual decision requires matching finalized draft'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER manual_decision_guard AFTER INSERT OR UPDATE ON "content_decisions"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_manual_decision();

CREATE TRIGGER manual_receipts_append_only BEFORE UPDATE OR DELETE ON "manual_review_receipts"
  FOR EACH ROW EXECUTE FUNCTION prevent_review_history_deletion();
