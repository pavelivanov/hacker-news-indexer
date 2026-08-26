ALTER TYPE "ReviewTaskKind" ADD VALUE 'FINDTHATPROJECT_EXPORT';

CREATE TYPE "ExportDestination" AS ENUM ('FINDTHATPROJECT');
CREATE TYPE "ExportAction" AS ENUM ('UPSERT', 'RETRACT');
CREATE TYPE "ExportDeliveryState" AS ENUM ('PENDING', 'ACKNOWLEDGED');

ALTER TABLE "review_tasks"
  ADD COLUMN "target_key" TEXT NOT NULL DEFAULT 'content',
  ADD COLUMN "target_snapshot_hash" TEXT;

DROP INDEX "review_tasks_content_decision_id_kind_revision_key";

CREATE UNIQUE INDEX "review_tasks_content_decision_id_kind_target_key_revision_key"
  ON "review_tasks"("content_decision_id", "kind", "target_key", "revision");

CREATE TABLE "export_outbox" (
  "id" UUID NOT NULL,
  "export_id" UUID NOT NULL,
  "destination" "ExportDestination" NOT NULL,
  "discovery_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "action" "ExportAction" NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "source_hash" TEXT NOT NULL,
  "delivery_state" "ExportDeliveryState" NOT NULL DEFAULT 'PENDING',
  "review_task_id" UUID,
  "acknowledged_at" TIMESTAMPTZ(3),
  "last_error_code" TEXT,
  "last_error_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "export_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "export_outbox_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "export_outbox_payload_hash_shape" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "export_outbox_source_hash_shape" CHECK ("source_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "export_outbox_export_id_revision_key"
  ON "export_outbox"("export_id", "revision");
CREATE UNIQUE INDEX "export_outbox_destination_discovery_id_revision_key"
  ON "export_outbox"("destination", "discovery_id", "revision");
CREATE UNIQUE INDEX "export_outbox_review_task_id_key"
  ON "export_outbox"("review_task_id");
CREATE INDEX "export_outbox_destination_delivery_state_created_at_id_idx"
  ON "export_outbox"("destination", "delivery_state", "created_at", "id");
CREATE INDEX "export_outbox_discovery_id_created_at_idx"
  ON "export_outbox"("discovery_id", "created_at");

ALTER TABLE "export_outbox"
  ADD CONSTRAINT "export_outbox_discovery_id_fkey"
  FOREIGN KEY ("discovery_id") REFERENCES "discoveries"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "export_outbox_review_task_id_fkey"
  FOREIGN KEY ("review_task_id") REFERENCES "review_tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "export_acknowledgements" (
  "id" UUID NOT NULL,
  "outbox_id" UUID NOT NULL,
  "destination" "ExportDestination" NOT NULL,
  "export_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "consumer_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "export_acknowledgements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "export_ack_revision_positive" CHECK ("revision" > 0),
  CONSTRAINT "export_ack_payload_hash_shape" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "export_acknowledgements_outbox_id_key"
  ON "export_acknowledgements"("outbox_id");
CREATE UNIQUE INDEX "export_acknowledgements_destination_idempotency_key_key"
  ON "export_acknowledgements"("destination", "idempotency_key");
CREATE UNIQUE INDEX "export_acknowledgements_export_id_revision_key"
  ON "export_acknowledgements"("export_id", "revision");
CREATE INDEX "export_acknowledgements_consumer_id_created_at_idx"
  ON "export_acknowledgements"("consumer_id", "created_at");

ALTER TABLE "export_acknowledgements"
  ADD CONSTRAINT "export_acknowledgements_outbox_id_fkey"
  FOREIGN KEY ("outbox_id") REFERENCES "export_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION protect_export_outbox_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.export_id IS DISTINCT FROM NEW.export_id
     OR OLD.destination IS DISTINCT FROM NEW.destination
     OR OLD.discovery_id IS DISTINCT FROM NEW.discovery_id
     OR OLD.revision IS DISTINCT FROM NEW.revision
     OR OLD.action IS DISTINCT FROM NEW.action
     OR OLD.payload IS DISTINCT FROM NEW.payload
     OR OLD.payload_hash IS DISTINCT FROM NEW.payload_hash
     OR OLD.source_hash IS DISTINCT FROM NEW.source_hash
     OR OLD.review_task_id IS DISTINCT FROM NEW.review_task_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'export outbox payloads are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER export_outbox_immutable_guard
  BEFORE UPDATE ON "export_outbox"
  FOR EACH ROW EXECUTE FUNCTION protect_export_outbox_immutable();

CREATE FUNCTION prevent_export_history_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'export history is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER export_outbox_delete_guard
  BEFORE DELETE ON "export_outbox"
  FOR EACH ROW EXECUTE FUNCTION prevent_export_history_delete();

CREATE TRIGGER export_ack_update_guard
  BEFORE UPDATE OR DELETE ON "export_acknowledgements"
  FOR EACH ROW EXECUTE FUNCTION prevent_export_history_delete();
