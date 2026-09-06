ALTER TABLE "classifier_result_snapshots"
  ADD COLUMN "bookmarked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "bookmark_version" INTEGER NOT NULL DEFAULT 0 CHECK ("bookmark_version" >= 0);
CREATE INDEX "classifier_result_snapshots_bookmarked_created_at_run_id_idx"
  ON "classifier_result_snapshots"("bookmarked", "created_at", "run_id");
CREATE TABLE "result_bookmark_receipts" (
  "command_key" VARCHAR(160) PRIMARY KEY,
  "result_id" UUID NOT NULL REFERENCES "classifier_result_snapshots"("run_id") ON DELETE RESTRICT,
  "request_hash" VARCHAR(64) NOT NULL,
  "bookmarked" BOOLEAN NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
