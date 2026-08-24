CREATE TYPE "HnItemType" AS ENUM ('comment', 'story', 'poll', 'pollopt', 'job');
CREATE TYPE "HnAvailabilityState" AS ENUM ('AVAILABLE', 'DELETED', 'DEAD', 'MISSING');
CREATE TYPE "MultipartState" AS ENUM ('AWAITING_PARTS', 'COMPLETE_MATCH', 'COMPLETE_MISMATCH', 'INCOMPLETE_SNAPSHOT', 'CONFLICTING_PARTS');
CREATE TYPE "UrlValidationState" AS ENUM ('CANDIDATE', 'VALID', 'REJECTED');

CREATE TABLE "hn_items" (
  "id" BIGINT NOT NULL,
  "type" "HnItemType" NOT NULL,
  "parent_id" BIGINT,
  "author" TEXT,
  "time" TIMESTAMPTZ(3),
  "title" TEXT,
  "text_html" TEXT,
  "text_plain" TEXT,
  "url" TEXT,
  "availability" "HnAvailabilityState" NOT NULL,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  "response_hash" TEXT NOT NULL,
  CONSTRAINT "hn_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hn_items_id_check" CHECK ("id" > 0)
);

CREATE TABLE "selected_comments" (
  "id" BIGINT NOT NULL,
  "root_id" BIGINT NOT NULL,
  "canonical_html" TEXT NOT NULL,
  "canonical_text" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL,
  "availability" "HnAvailabilityState" NOT NULL,
  "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "selected_comments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "resolution_paths" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "selected_comment_id" BIGINT NOT NULL,
  "ancestor_ids" BIGINT[] NOT NULL,
  "displayed_story_id" BIGINT,
  "resolved_root_id" BIGINT NOT NULL,
  "resolver_version" TEXT NOT NULL,
  "resolved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "resolution_paths_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "multipart_groups" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "selected_comment_id" BIGINT NOT NULL,
  "expected_parts" INTEGER NOT NULL,
  "state" "MultipartState" NOT NULL,
  "canonical_source" TEXT NOT NULL DEFAULT 'HN',
  "snapshot_hash" TEXT,
  CONSTRAINT "multipart_groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "multipart_groups_expected_parts_check" CHECK ("expected_parts" > 1)
);

CREATE TABLE "multipart_parts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "group_id" UUID NOT NULL,
  "occurrence_id" UUID NOT NULL,
  "part_no" INTEGER NOT NULL,
  "observed_total" INTEGER NOT NULL,
  "fragment_hash" TEXT NOT NULL,
  "fragment_snapshot" TEXT,
  CONSTRAINT "multipart_parts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "multipart_parts_number_check" CHECK ("part_no" > 0 AND "observed_total" >= "part_no")
);

CREATE TABLE "url_candidates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "hn_item_id" BIGINT,
  "raw_url" TEXT NOT NULL,
  "canonical_url" TEXT,
  "source_document" TEXT NOT NULL,
  "origin_field" TEXT NOT NULL,
  "scheme" TEXT,
  "host" TEXT,
  "validation_state" "UrlValidationState" NOT NULL DEFAULT 'CANDIDATE',
  "content_hash" TEXT NOT NULL,
  CONSTRAINT "url_candidates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "hn_items_parent_id_idx" ON "hn_items"("parent_id");
CREATE INDEX "hn_items_type_availability_idx" ON "hn_items"("type", "availability");
CREATE INDEX "selected_comments_root_id_idx" ON "selected_comments"("root_id");
CREATE UNIQUE INDEX "resolution_paths_selected_comment_id_key" ON "resolution_paths"("selected_comment_id");
CREATE INDEX "resolution_paths_resolved_root_id_idx" ON "resolution_paths"("resolved_root_id");
CREATE UNIQUE INDEX "multipart_groups_selected_comment_id_key" ON "multipart_groups"("selected_comment_id");
CREATE UNIQUE INDEX "multipart_parts_occurrence_id_key" ON "multipart_parts"("occurrence_id");
CREATE UNIQUE INDEX "multipart_parts_group_id_part_no_key" ON "multipart_parts"("group_id", "part_no");
CREATE UNIQUE INDEX "url_candidates_content_hash_source_document_origin_field_key" ON "url_candidates"("content_hash", "source_document", "origin_field");
CREATE INDEX "url_candidates_hn_item_id_idx" ON "url_candidates"("hn_item_id");

ALTER TABLE "selected_comments" ADD CONSTRAINT "selected_comments_id_fkey" FOREIGN KEY ("id") REFERENCES "hn_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "resolution_paths" ADD CONSTRAINT "resolution_paths_selected_comment_id_fkey" FOREIGN KEY ("selected_comment_id") REFERENCES "selected_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "multipart_groups" ADD CONSTRAINT "multipart_groups_selected_comment_id_fkey" FOREIGN KEY ("selected_comment_id") REFERENCES "selected_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "multipart_parts" ADD CONSTRAINT "multipart_parts_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "multipart_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "multipart_parts" ADD CONSTRAINT "multipart_parts_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "selection_occurrences"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "url_candidates" ADD CONSTRAINT "url_candidates_hn_item_id_fkey" FOREIGN KEY ("hn_item_id") REFERENCES "hn_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
