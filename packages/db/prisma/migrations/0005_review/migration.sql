CREATE TYPE "ReviewTaskState" AS ENUM ('OPEN', 'APPROVED', 'REJECTED', 'SUPERSEDED');
CREATE TYPE "ReviewPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "ReviewAuditAction" AS ENUM ('OPENED', 'APPROVED', 'REJECTED', 'REOPENED', 'SUPERSEDED');

CREATE TABLE "review_tasks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "comment_id" BIGINT NOT NULL,
  "content_decision_id" UUID NOT NULL,
  "state" "ReviewTaskState" NOT NULL DEFAULT 'OPEN',
  "priority" "ReviewPriority" NOT NULL,
  "reason_codes" TEXT[] NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "supersedes_task_id" UUID,
  "resolution_reason" TEXT,
  "resolved_by" TEXT,
  "resolved_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "review_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "review_tasks_version_check" CHECK ("version" > 0 AND "revision" > 0),
  CONSTRAINT "review_tasks_reasons_check" CHECK (
    cardinality("reason_codes") > 0 AND
    "reason_codes" <@ ARRAY[
      'PROMPT_INJECTION',
      'DESTRUCTIVE_OR_EVASION_ADVICE',
      'DELETED_OR_FLAGGED_CONTENT',
      'SECURITY_RECOMMENDATION',
      'MEDICAL_RECOMMENDATION',
      'LEGAL_RECOMMENDATION',
      'TELEGRAM_HN_DIVERGENCE',
      'CONFLICTING_EVIDENCE_ORIGIN',
      'FINDTHATPROJECT_INITIAL_ROLLOUT',
      'NAME_ONLY_MERGE_SUGGESTION',
      'AMBIGUOUS_CANONICAL_URL',
      'MISSING_CANONICAL_URL',
      'ROOT_ONLY_DISCOVERY',
      'LOW_CONFIDENCE',
      'AMBIGUOUS_CLASSIFICATION',
      'UNPROMOTED_MODEL_DECISION'
    ]::TEXT[]
  ),
  CONSTRAINT "review_tasks_revision_check" CHECK (
    ("revision" = 1 AND "supersedes_task_id" IS NULL) OR
    ("revision" > 1 AND "supersedes_task_id" IS NOT NULL)
  ),
  CONSTRAINT "review_tasks_resolution_check" CHECK (
    (
      "state" = 'OPEN' AND
      "resolution_reason" IS NULL AND
      "resolved_by" IS NULL AND
      "resolved_at" IS NULL
    ) OR (
      "state" <> 'OPEN' AND
      "resolution_reason" IS NOT NULL AND
      "resolved_by" IS NOT NULL AND
      "resolved_at" IS NOT NULL
    )
  )
);

CREATE TABLE "manual_override_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "review_task_id" UUID NOT NULL,
  "comment_id" BIGINT NOT NULL,
  "action" "ReviewAuditAction" NOT NULL,
  "previous_decision_id" UUID,
  "new_decision_id" UUID,
  "actor_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "previous_value_hash" TEXT NOT NULL,
  "new_value_hash" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "command_key" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "manual_override_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "manual_override_events_text_check" CHECK (
    char_length("actor_id") BETWEEN 1 AND 128 AND
    char_length("request_hash") BETWEEN 1 AND 256 AND
    char_length("previous_value_hash") BETWEEN 1 AND 256 AND
    char_length("new_value_hash") BETWEEN 1 AND 256 AND
    char_length("reason") BETWEEN 1 AND 1000 AND
    char_length("command_key") BETWEEN 1 AND 256
  )
);

CREATE UNIQUE INDEX "review_tasks_content_decision_id_revision_key"
  ON "review_tasks"("content_decision_id", "revision");
CREATE INDEX "review_tasks_state_priority_created_at_id_idx"
  ON "review_tasks"("state", "priority", "created_at", "id");
CREATE INDEX "review_tasks_comment_id_created_at_idx"
  ON "review_tasks"("comment_id", "created_at");
CREATE INDEX "review_tasks_supersedes_task_id_idx"
  ON "review_tasks"("supersedes_task_id");
CREATE UNIQUE INDEX "manual_override_events_command_key_key"
  ON "manual_override_events"("command_key");
CREATE INDEX "manual_override_events_review_task_id_created_at_idx"
  ON "manual_override_events"("review_task_id", "created_at");
CREATE INDEX "manual_override_events_comment_id_created_at_idx"
  ON "manual_override_events"("comment_id", "created_at");

ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_comment_id_fkey"
  FOREIGN KEY ("comment_id") REFERENCES "selected_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_content_decision_id_fkey"
  FOREIGN KEY ("content_decision_id") REFERENCES "content_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "review_tasks" ADD CONSTRAINT "review_tasks_supersedes_task_id_fkey"
  FOREIGN KEY ("supersedes_task_id") REFERENCES "review_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_override_events" ADD CONSTRAINT "manual_override_events_review_task_id_fkey"
  FOREIGN KEY ("review_task_id") REFERENCES "review_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_override_events" ADD CONSTRAINT "manual_override_events_comment_id_fkey"
  FOREIGN KEY ("comment_id") REFERENCES "selected_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_override_events" ADD CONSTRAINT "manual_override_events_previous_decision_id_fkey"
  FOREIGN KEY ("previous_decision_id") REFERENCES "content_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_override_events" ADD CONSTRAINT "manual_override_events_new_decision_id_fkey"
  FOREIGN KEY ("new_decision_id") REFERENCES "content_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION enforce_review_task_transition() RETURNS trigger AS $$
BEGIN
  IF
    OLD."comment_id" <> NEW."comment_id" OR
    OLD."content_decision_id" <> NEW."content_decision_id" OR
    OLD."priority" <> NEW."priority" OR
    OLD."reason_codes" <> NEW."reason_codes" OR
    OLD."revision" <> NEW."revision" OR
    OLD."supersedes_task_id" IS DISTINCT FROM NEW."supersedes_task_id" OR
    OLD."created_at" <> NEW."created_at" OR
    OLD."state" <> 'OPEN' OR
    NEW."state" NOT IN ('APPROVED', 'REJECTED', 'SUPERSEDED') OR
    NEW."version" <> OLD."version" + 1
  THEN
    RAISE EXCEPTION 'invalid review task transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER review_tasks_transition_guard
  BEFORE UPDATE ON "review_tasks"
  FOR EACH ROW EXECUTE FUNCTION enforce_review_task_transition();

CREATE FUNCTION prevent_review_history_deletion() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'review history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER review_tasks_no_delete
  BEFORE DELETE ON "review_tasks"
  FOR EACH ROW EXECUTE FUNCTION prevent_review_history_deletion();
CREATE TRIGGER manual_override_events_append_only
  BEFORE UPDATE OR DELETE ON "manual_override_events"
  FOR EACH ROW EXECUTE FUNCTION prevent_review_history_deletion();

CREATE FUNCTION require_review_task_audit_event() RETURNS trigger AS $$
DECLARE
  expected_action TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'OPEN' THEN
      RAISE EXCEPTION 'new review task must be open';
    END IF;
    expected_action := CASE
      WHEN NEW."revision" = 1 THEN 'OPENED'
      ELSE 'REOPENED'
    END;
  ELSE
    expected_action := NEW."state"::TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "manual_override_events"
    WHERE
      "manual_override_events"."review_task_id" = NEW."id" AND
      "manual_override_events"."action"::TEXT = expected_action AND
      (
        TG_OP = 'INSERT' OR (
          "manual_override_events"."actor_id" = NEW."resolved_by" AND
          "manual_override_events"."reason" = NEW."resolution_reason" AND
          (
            NEW."state" <> 'APPROVED' OR
            "manual_override_events"."new_decision_id" = NEW."content_decision_id"
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'review task transition requires matching audit event';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER review_tasks_audit_guard
  AFTER INSERT OR UPDATE ON "review_tasks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_review_task_audit_event();

CREATE FUNCTION require_approved_active_decision() RETURNS trigger AS $$
DECLARE
  decision_changed BOOLEAN;
BEGIN
  decision_changed := CASE
    WHEN TG_OP = 'INSERT' THEN NEW."active_decision_id" IS NOT NULL
    ELSE NEW."active_decision_id" IS DISTINCT FROM OLD."active_decision_id"
  END;

  IF
    decision_changed AND
    NEW."active_decision_id" IS NOT NULL AND
    NOT EXISTS (
      SELECT 1
      FROM "review_tasks"
      WHERE
        "review_tasks"."comment_id" = NEW."id" AND
        "review_tasks"."content_decision_id" = NEW."active_decision_id" AND
        "review_tasks"."state" = 'APPROVED' AND
        EXISTS (
          SELECT 1
          FROM "manual_override_events"
          WHERE
            "manual_override_events"."review_task_id" = "review_tasks"."id" AND
            "manual_override_events"."action" = 'APPROVED' AND
            "manual_override_events"."new_decision_id" = NEW."active_decision_id"
        )
    )
  THEN
    RAISE EXCEPTION 'active decision requires approved review';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER selected_comments_review_activation_guard
  AFTER INSERT OR UPDATE ON "selected_comments"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION require_approved_active_decision();
