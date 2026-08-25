CREATE TYPE "SubjectType" AS ENUM ('PROJECT', 'TOOL', 'LIBRARY', 'SERVICE', 'PRODUCT', 'FEATURE', 'PLUGIN', 'AGENT_SKILL', 'GUIDE', 'RESOURCE');
CREATE TYPE "SubjectIdentityBasis" AS ENUM ('ECOSYSTEM_COORDINATE', 'CANONICAL_URL', 'OFFICIAL_DOMAIN', 'NAME_CONTEXT');
CREATE TYPE "SubjectLifecycleState" AS ENUM ('ACTIVE', 'MERGED', 'TOMBSTONED');
CREATE TYPE "MaterializedEvidenceOrigin" AS ENUM ('COMMENT', 'ROOT_STORY', 'BOTH');
CREATE TYPE "MaterializedContentStatus" AS ENUM ('REVIEW_PENDING', 'APPROVED', 'REJECTED', 'SUPERSEDED');
CREATE TYPE "SubjectMentionSource" AS ENUM ('DISCOVERY', 'EXPERT_NOTE');
CREATE TYPE "ExpertNoteType" AS ENUM ('TECHNICAL_EXPLANATION', 'CORRECTION', 'PRODUCT_EXPERIENCE', 'IMPLEMENTATION_CAVEAT', 'SECURITY', 'OPERATIONS', 'COMPARISON', 'GUIDE');
CREATE TYPE "ReviewTaskKind" AS ENUM ('CONTENT_DECISION', 'SUBJECT_MERGE', 'URL_RESOLUTION');

ALTER TABLE "review_tasks"
  ADD COLUMN "kind" "ReviewTaskKind" NOT NULL DEFAULT 'CONTENT_DECISION';
ALTER TABLE "manual_override_events"
  ADD COLUMN "affected_subject_id" UUID,
  ADD COLUMN "related_subject_id" UUID,
  ADD COLUMN "previous_url_candidate_id" UUID,
  ADD COLUMN "new_url_candidate_id" UUID;
ALTER TABLE "url_candidates"
  ADD COLUMN "source_ordinal" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "classifier_eligible" BOOLEAN NOT NULL DEFAULT TRUE,
  ADD CONSTRAINT "url_candidates_source_ordinal_check" CHECK ("source_ordinal" >= 0);
DROP INDEX "url_candidates_content_hash_source_document_origin_field_key";
CREATE UNIQUE INDEX "url_candidates_content_hash_source_document_origin_field_source_ordinal_key"
  ON "url_candidates"("content_hash", "source_document", "origin_field", "source_ordinal");
DROP INDEX "review_tasks_content_decision_id_revision_key";
CREATE UNIQUE INDEX "review_tasks_content_decision_id_kind_revision_key"
  ON "review_tasks"("content_decision_id", "kind", "revision");
CREATE INDEX "url_candidates_classifier_eligible_source_document_source_ordinal_idx"
  ON "url_candidates"("classifier_eligible", "source_document", "source_ordinal");

CREATE TABLE "subjects" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "type" "SubjectType" NOT NULL,
  "name" TEXT NOT NULL,
  "normalized_name" TEXT NOT NULL,
  "dedup_key" TEXT NOT NULL,
  "identity_basis" "SubjectIdentityBasis" NOT NULL,
  "ecosystem_coordinate" TEXT,
  "canonical_url_candidate_id" UUID,
  "official_domain" TEXT,
  "context_key" TEXT NOT NULL,
  "lifecycle_state" "SubjectLifecycleState" NOT NULL DEFAULT 'ACTIVE',
  "merged_into_subject_id" UUID,
  "created_from_decision_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "subjects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subjects_text_check" CHECK (
    char_length("name") BETWEEN 1 AND 160 AND
    char_length("normalized_name") BETWEEN 1 AND 160 AND
    char_length("dedup_key") BETWEEN 1 AND 96 AND
    char_length("context_key") BETWEEN 1 AND 256 AND
    ("ecosystem_coordinate" IS NULL OR char_length("ecosystem_coordinate") BETWEEN 1 AND 512) AND
    ("official_domain" IS NULL OR char_length("official_domain") BETWEEN 1 AND 253)
  ),
  CONSTRAINT "subjects_identity_check" CHECK (
    ("identity_basis" <> 'ECOSYSTEM_COORDINATE' OR "ecosystem_coordinate" IS NOT NULL) AND
    ("identity_basis" <> 'CANONICAL_URL' OR "canonical_url_candidate_id" IS NOT NULL) AND
    ("identity_basis" <> 'OFFICIAL_DOMAIN' OR "official_domain" IS NOT NULL)
  ),
  CONSTRAINT "subjects_merge_check" CHECK (
    (("lifecycle_state" = 'MERGED') = ("merged_into_subject_id" IS NOT NULL)) AND
    "merged_into_subject_id" IS DISTINCT FROM "id"
  )
);

CREATE TABLE "subject_aliases" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "subject_id" UUID NOT NULL,
  "alias" TEXT NOT NULL,
  "normalized_alias" TEXT NOT NULL,
  "content_decision_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subject_aliases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subject_aliases_text_check" CHECK (
    char_length("alias") BETWEEN 1 AND 160 AND
    char_length("normalized_alias") BETWEEN 1 AND 160
  )
);

CREATE TABLE "subject_mentions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "subject_id" UUID NOT NULL,
  "selected_comment_id" BIGINT NOT NULL,
  "content_decision_id" UUID NOT NULL,
  "source_kind" "SubjectMentionSource" NOT NULL,
  "source_ordinal" INTEGER NOT NULL,
  "evidence_origin" "MaterializedEvidenceOrigin" NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "extraction_version" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subject_mentions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subject_mentions_values_check" CHECK (
    "source_ordinal" >= 0 AND
    "confidence" >= 0 AND "confidence" <= 1 AND
    char_length("extraction_version") BETWEEN 1 AND 128
  )
);

CREATE TABLE "subject_mention_evidence_spans" (
  "subject_mention_id" UUID NOT NULL,
  "evidence_span_id" UUID NOT NULL,
  CONSTRAINT "subject_mention_evidence_spans_pkey" PRIMARY KEY ("subject_mention_id", "evidence_span_id")
);

CREATE TABLE "discoveries" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "subject_id" UUID NOT NULL,
  "resolved_root_id" BIGINT,
  "identity_key" TEXT NOT NULL,
  "root_story_only" BOOLEAN NOT NULL,
  "extraction_version" TEXT NOT NULL,
  "status" "MaterializedContentStatus" NOT NULL DEFAULT 'REVIEW_PENDING',
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "discoveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "discoveries_identity_check" CHECK (
    char_length("identity_key") BETWEEN 1 AND 96 AND
    char_length("extraction_version") BETWEEN 1 AND 128 AND
    ("root_story_only" = ("resolved_root_id" IS NOT NULL))
  )
);

CREATE TABLE "discovery_sources" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "discovery_id" UUID NOT NULL,
  "selected_comment_id" BIGINT NOT NULL,
  "content_decision_id" UUID NOT NULL,
  "source_ordinal" INTEGER NOT NULL,
  "description_claim" TEXT NOT NULL,
  "evidence_origin" "MaterializedEvidenceOrigin" NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "discovery_sources_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "discovery_sources_values_check" CHECK (
    "source_ordinal" >= 0 AND
    char_length("description_claim") BETWEEN 1 AND 1000 AND
    "confidence" >= 0 AND "confidence" <= 1
  )
);

CREATE TABLE "discovery_source_evidence_spans" (
  "discovery_source_id" UUID NOT NULL,
  "evidence_span_id" UUID NOT NULL,
  CONSTRAINT "discovery_source_evidence_spans_pkey" PRIMARY KEY ("discovery_source_id", "evidence_span_id")
);

CREATE TABLE "expert_notes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "selected_comment_id" BIGINT NOT NULL,
  "content_decision_id" UUID NOT NULL,
  "note_type" "ExpertNoteType" NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "related_subject_names" TEXT[] NOT NULL,
  "evidence_origin" "MaterializedEvidenceOrigin" NOT NULL,
  "confidence" DOUBLE PRECISION NOT NULL,
  "status" "MaterializedContentStatus" NOT NULL DEFAULT 'REVIEW_PENDING',
  "extraction_version" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "expert_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "expert_notes_values_check" CHECK (
    char_length("title") BETWEEN 1 AND 200 AND
    char_length("summary") BETWEEN 1 AND 2000 AND
    cardinality("related_subject_names") <= 12 AND
    char_length("extraction_version") BETWEEN 1 AND 128 AND
    "confidence" >= 0 AND "confidence" <= 1
  )
);

CREATE TABLE "expert_note_subjects" (
  "expert_note_id" UUID NOT NULL,
  "subject_id" UUID NOT NULL,
  CONSTRAINT "expert_note_subjects_pkey" PRIMARY KEY ("expert_note_id", "subject_id")
);

CREATE TABLE "expert_note_evidence_spans" (
  "expert_note_id" UUID NOT NULL,
  "evidence_span_id" UUID NOT NULL,
  CONSTRAINT "expert_note_evidence_spans_pkey" PRIMARY KEY ("expert_note_id", "evidence_span_id")
);

CREATE UNIQUE INDEX "subjects_dedup_key_key" ON "subjects"("dedup_key");
CREATE INDEX "subjects_normalized_name_type_idx" ON "subjects"("normalized_name", "type");
CREATE INDEX "subjects_ecosystem_coordinate_idx" ON "subjects"("ecosystem_coordinate");
CREATE INDEX "subjects_official_domain_idx" ON "subjects"("official_domain");
CREATE INDEX "subjects_canonical_url_candidate_id_idx" ON "subjects"("canonical_url_candidate_id");
CREATE INDEX "subjects_merged_into_subject_id_idx" ON "subjects"("merged_into_subject_id");
CREATE INDEX "subjects_created_from_decision_id_idx" ON "subjects"("created_from_decision_id");
CREATE UNIQUE INDEX "subject_aliases_subject_id_normalized_alias_key" ON "subject_aliases"("subject_id", "normalized_alias");
CREATE INDEX "subject_aliases_content_decision_id_idx" ON "subject_aliases"("content_decision_id");
CREATE UNIQUE INDEX "subject_mentions_content_decision_id_source_kind_source_ordinal_subject_id_key" ON "subject_mentions"("content_decision_id", "source_kind", "source_ordinal", "subject_id");
CREATE INDEX "subject_mentions_subject_id_created_at_idx" ON "subject_mentions"("subject_id", "created_at");
CREATE INDEX "subject_mentions_selected_comment_id_idx" ON "subject_mentions"("selected_comment_id");
CREATE INDEX "subject_mention_evidence_spans_evidence_span_id_idx" ON "subject_mention_evidence_spans"("evidence_span_id");
CREATE UNIQUE INDEX "discoveries_identity_key_key" ON "discoveries"("identity_key");
CREATE INDEX "discoveries_subject_id_status_idx" ON "discoveries"("subject_id", "status");
CREATE INDEX "discoveries_resolved_root_id_idx" ON "discoveries"("resolved_root_id");
CREATE UNIQUE INDEX "discovery_sources_content_decision_id_source_ordinal_key" ON "discovery_sources"("content_decision_id", "source_ordinal");
CREATE INDEX "discovery_sources_discovery_id_created_at_idx" ON "discovery_sources"("discovery_id", "created_at");
CREATE INDEX "discovery_sources_selected_comment_id_idx" ON "discovery_sources"("selected_comment_id");
CREATE INDEX "discovery_source_evidence_spans_evidence_span_id_idx" ON "discovery_source_evidence_spans"("evidence_span_id");
CREATE UNIQUE INDEX "expert_notes_content_decision_id_extraction_version_key" ON "expert_notes"("content_decision_id", "extraction_version");
CREATE INDEX "expert_notes_selected_comment_id_status_idx" ON "expert_notes"("selected_comment_id", "status");
CREATE INDEX "expert_note_subjects_subject_id_idx" ON "expert_note_subjects"("subject_id");
CREATE INDEX "expert_note_evidence_spans_evidence_span_id_idx" ON "expert_note_evidence_spans"("evidence_span_id");

ALTER TABLE "subjects" ADD CONSTRAINT "subjects_canonical_url_candidate_id_fkey" FOREIGN KEY ("canonical_url_candidate_id") REFERENCES "url_candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_created_from_decision_id_fkey" FOREIGN KEY ("created_from_decision_id") REFERENCES "content_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_merged_into_subject_id_fkey" FOREIGN KEY ("merged_into_subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subject_aliases" ADD CONSTRAINT "subject_aliases_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subject_aliases" ADD CONSTRAINT "subject_aliases_content_decision_id_fkey" FOREIGN KEY ("content_decision_id") REFERENCES "content_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subject_mentions" ADD CONSTRAINT "subject_mentions_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subject_mentions" ADD CONSTRAINT "subject_mentions_selected_comment_id_fkey" FOREIGN KEY ("selected_comment_id") REFERENCES "selected_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subject_mentions" ADD CONSTRAINT "subject_mentions_content_decision_id_fkey" FOREIGN KEY ("content_decision_id") REFERENCES "content_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subject_mention_evidence_spans" ADD CONSTRAINT "subject_mention_evidence_spans_subject_mention_id_fkey" FOREIGN KEY ("subject_mention_id") REFERENCES "subject_mentions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subject_mention_evidence_spans" ADD CONSTRAINT "subject_mention_evidence_spans_evidence_span_id_fkey" FOREIGN KEY ("evidence_span_id") REFERENCES "evidence_spans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discoveries" ADD CONSTRAINT "discoveries_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discoveries" ADD CONSTRAINT "discoveries_resolved_root_id_fkey" FOREIGN KEY ("resolved_root_id") REFERENCES "hn_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_discovery_id_fkey" FOREIGN KEY ("discovery_id") REFERENCES "discoveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_selected_comment_id_fkey" FOREIGN KEY ("selected_comment_id") REFERENCES "selected_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discovery_sources" ADD CONSTRAINT "discovery_sources_content_decision_id_fkey" FOREIGN KEY ("content_decision_id") REFERENCES "content_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discovery_source_evidence_spans" ADD CONSTRAINT "discovery_source_evidence_spans_discovery_source_id_fkey" FOREIGN KEY ("discovery_source_id") REFERENCES "discovery_sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "discovery_source_evidence_spans" ADD CONSTRAINT "discovery_source_evidence_spans_evidence_span_id_fkey" FOREIGN KEY ("evidence_span_id") REFERENCES "evidence_spans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expert_notes" ADD CONSTRAINT "expert_notes_selected_comment_id_fkey" FOREIGN KEY ("selected_comment_id") REFERENCES "selected_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expert_notes" ADD CONSTRAINT "expert_notes_content_decision_id_fkey" FOREIGN KEY ("content_decision_id") REFERENCES "content_decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expert_note_subjects" ADD CONSTRAINT "expert_note_subjects_expert_note_id_fkey" FOREIGN KEY ("expert_note_id") REFERENCES "expert_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expert_note_subjects" ADD CONSTRAINT "expert_note_subjects_subject_id_fkey" FOREIGN KEY ("subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expert_note_evidence_spans" ADD CONSTRAINT "expert_note_evidence_spans_expert_note_id_fkey" FOREIGN KEY ("expert_note_id") REFERENCES "expert_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expert_note_evidence_spans" ADD CONSTRAINT "expert_note_evidence_spans_evidence_span_id_fkey" FOREIGN KEY ("evidence_span_id") REFERENCES "evidence_spans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "manual_override_events_affected_subject_id_created_at_idx" ON "manual_override_events"("affected_subject_id", "created_at");
CREATE INDEX "manual_override_events_related_subject_id_created_at_idx" ON "manual_override_events"("related_subject_id", "created_at");
ALTER TABLE "manual_override_events" ADD CONSTRAINT "manual_override_events_affected_subject_id_fkey" FOREIGN KEY ("affected_subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_override_events" ADD CONSTRAINT "manual_override_events_related_subject_id_fkey" FOREIGN KEY ("related_subject_id") REFERENCES "subjects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_override_events" ADD CONSTRAINT "manual_override_events_previous_url_candidate_id_fkey" FOREIGN KEY ("previous_url_candidate_id") REFERENCES "url_candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_override_events" ADD CONSTRAINT "manual_override_events_new_url_candidate_id_fkey" FOREIGN KEY ("new_url_candidate_id") REFERENCES "url_candidates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "manual_override_events" ADD CONSTRAINT "manual_override_events_entity_shape_check" CHECK (
  (
    "affected_subject_id" IS NULL AND
    "related_subject_id" IS NULL AND
    "previous_url_candidate_id" IS NULL AND
    "new_url_candidate_id" IS NULL
  ) OR (
    "affected_subject_id" IS NOT NULL AND
    "related_subject_id" IS NOT NULL AND
    "previous_url_candidate_id" IS NULL AND
    "new_url_candidate_id" IS NULL AND
    "affected_subject_id" <> "related_subject_id"
  ) OR (
    "affected_subject_id" IS NOT NULL AND
    "related_subject_id" IS NULL AND
    "new_url_candidate_id" IS NOT NULL
  )
);

CREATE OR REPLACE FUNCTION enforce_review_task_transition() RETURNS trigger AS $$
BEGIN
  IF
    OLD."comment_id" <> NEW."comment_id" OR
    OLD."content_decision_id" <> NEW."content_decision_id" OR
    OLD."kind" <> NEW."kind" OR
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

CREATE OR REPLACE FUNCTION require_approved_active_decision() RETURNS trigger AS $$
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
        "review_tasks"."kind" = 'CONTENT_DECISION' AND
        "review_tasks"."state" = 'APPROVED' AND
        EXISTS (
          SELECT 1
          FROM "manual_override_events"
          WHERE
            "manual_override_events"."review_task_id" = "review_tasks"."id" AND
            "manual_override_events"."action" = 'APPROVED' AND
            "manual_override_events"."new_decision_id" = NEW."active_decision_id" AND
            "manual_override_events"."affected_subject_id" IS NULL
        )
    )
  THEN
    RAISE EXCEPTION 'active decision requires approved review';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
