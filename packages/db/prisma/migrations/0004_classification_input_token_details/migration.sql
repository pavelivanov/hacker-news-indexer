ALTER TABLE "classification_runs"
  ADD COLUMN "cached_input_tokens" INTEGER,
  ADD COLUMN "cache_write_input_tokens" INTEGER;

ALTER TABLE "classification_runs"
  ADD CONSTRAINT "classification_runs_input_token_details_check" CHECK (
    ("cached_input_tokens" IS NULL OR "cached_input_tokens" >= 0) AND
    ("cache_write_input_tokens" IS NULL OR "cache_write_input_tokens" >= 0) AND
    (
      "input_tokens" IS NULL OR
      COALESCE("cached_input_tokens", 0) +
        COALESCE("cache_write_input_tokens", 0) <= "input_tokens"
    )
  );
