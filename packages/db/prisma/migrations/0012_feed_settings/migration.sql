ALTER TABLE "feed_processing_state"
  ADD COLUMN "settings_version" INTEGER NOT NULL DEFAULT 0 CHECK ("settings_version" >= 0);
