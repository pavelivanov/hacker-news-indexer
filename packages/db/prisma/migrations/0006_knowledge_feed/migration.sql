ALTER TYPE "PipelineJobType" ADD VALUE 'RECONCILE_HN_ITEM';

CREATE TYPE "HnReconciliationOutcome" AS ENUM (
  'UNCHANGED',
  'CONTENT_CHANGED',
  'ROOT_CHANGED',
  'TOMBSTONED'
);

ALTER TABLE "discoveries"
  ADD COLUMN "publication_revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "expert_notes"
  ADD COLUMN "publication_revision" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "hn_item_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "hn_item_id" BIGINT NOT NULL,
  "type" "HnItemType" NOT NULL,
  "parent_id" BIGINT,
  "title" TEXT,
  "text_html" TEXT,
  "text_plain" TEXT,
  "url" TEXT,
  "availability" "HnAvailabilityState" NOT NULL,
  "response_hash" TEXT NOT NULL,
  "observed_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "hn_item_revisions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "selected_comment_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "selected_comment_id" BIGINT NOT NULL,
  "revision" INTEGER NOT NULL,
  "root_id" BIGINT NOT NULL,
  "canonical_html" TEXT,
  "canonical_text" TEXT,
  "content_hash" TEXT NOT NULL,
  "availability" "HnAvailabilityState" NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "superseded_at" TIMESTAMPTZ(3),
  CONSTRAINT "selected_comment_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "selected_comment_revisions_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "resolution_path_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "selected_comment_id" BIGINT NOT NULL,
  "revision" INTEGER NOT NULL,
  "ancestor_ids" BIGINT[] NOT NULL,
  "displayed_story_id" BIGINT,
  "resolved_root_id" BIGINT NOT NULL,
  "resolver_version" TEXT NOT NULL,
  "resolved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "resolution_path_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "resolution_path_revisions_revision_check" CHECK ("revision" > 0)
);

CREATE TABLE "hn_reconciliation_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "selected_comment_id" BIGINT NOT NULL,
  "outcome" "HnReconciliationOutcome" NOT NULL,
  "previous_response_hash" TEXT,
  "current_response_hash" TEXT NOT NULL,
  "previous_content_hash" TEXT NOT NULL,
  "current_content_hash" TEXT NOT NULL,
  "previous_root_id" BIGINT NOT NULL,
  "current_root_id" BIGINT NOT NULL,
  "availability" "HnAvailabilityState" NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hn_reconciliation_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hn_item_revisions_hn_item_id_response_hash_key"
  ON "hn_item_revisions"("hn_item_id", "response_hash");
CREATE INDEX "hn_item_revisions_hn_item_id_observed_at_idx"
  ON "hn_item_revisions"("hn_item_id", "observed_at");
CREATE UNIQUE INDEX "selected_comment_revisions_selected_comment_id_revision_key"
  ON "selected_comment_revisions"("selected_comment_id", "revision");
CREATE UNIQUE INDEX "selected_comment_revisions_selected_comment_id_content_hash_key"
  ON "selected_comment_revisions"("selected_comment_id", "content_hash");
CREATE INDEX "selected_comment_revisions_selected_comment_id_created_at_idx"
  ON "selected_comment_revisions"("selected_comment_id", "created_at");
CREATE UNIQUE INDEX "resolution_path_revisions_selected_comment_id_revision_key"
  ON "resolution_path_revisions"("selected_comment_id", "revision");
CREATE INDEX "resolution_path_revisions_resolved_root_id_resolved_at_idx"
  ON "resolution_path_revisions"("resolved_root_id", "resolved_at");
CREATE UNIQUE INDEX "hn_reconciliation_events_idempotency_key_key"
  ON "hn_reconciliation_events"("idempotency_key");
CREATE INDEX "hn_reconciliation_events_selected_comment_id_created_at_idx"
  ON "hn_reconciliation_events"("selected_comment_id", "created_at");
CREATE INDEX "hn_reconciliation_events_outcome_created_at_idx"
  ON "hn_reconciliation_events"("outcome", "created_at");

ALTER TABLE "hn_item_revisions" ADD CONSTRAINT "hn_item_revisions_hn_item_id_fkey"
  FOREIGN KEY ("hn_item_id") REFERENCES "hn_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "selected_comment_revisions" ADD CONSTRAINT "selected_comment_revisions_selected_comment_id_fkey"
  FOREIGN KEY ("selected_comment_id") REFERENCES "selected_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "resolution_path_revisions" ADD CONSTRAINT "resolution_path_revisions_selected_comment_id_fkey"
  FOREIGN KEY ("selected_comment_id") REFERENCES "selected_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hn_reconciliation_events" ADD CONSTRAINT "hn_reconciliation_events_selected_comment_id_fkey"
  FOREIGN KEY ("selected_comment_id") REFERENCES "selected_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "hn_item_revisions" (
  "hn_item_id", "type", "parent_id", "title", "text_html", "text_plain",
  "url", "availability", "response_hash", "observed_at"
)
SELECT
  "id", "type", "parent_id", "title", "text_html", "text_plain", "url",
  "availability", "response_hash", "fetched_at"
FROM "hn_items";

INSERT INTO "selected_comment_revisions" (
  "selected_comment_id", "revision", "root_id", "canonical_html",
  "canonical_text", "content_hash", "availability", "created_at"
)
SELECT
  "id", 1, "root_id", "canonical_html", "canonical_text", "content_hash",
  "availability", "first_seen_at"
FROM "selected_comments";

INSERT INTO "resolution_path_revisions" (
  "selected_comment_id", "revision", "ancestor_ids", "displayed_story_id",
  "resolved_root_id", "resolver_version", "resolved_at"
)
SELECT
  "selected_comment_id", 1, "ancestor_ids", "displayed_story_id",
  "resolved_root_id", "resolver_version", "resolved_at"
FROM "resolution_paths";
