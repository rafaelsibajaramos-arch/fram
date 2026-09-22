ALTER TABLE "reservas_inventario"
  ADD COLUMN IF NOT EXISTS "buyer_id" UUID;

-- La base se estrena sin reservas; este valor solo protege instalaciones que
-- hubieran creado datos de demostracion antes de la migracion.
UPDATE "reservas_inventario"
SET "buyer_id" = '00000000-0000-4000-8000-000000000000'
WHERE "buyer_id" IS NULL;

ALTER TABLE "reservas_inventario"
  ALTER COLUMN "buyer_id" SET NOT NULL;

CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id" UUID NOT NULL,
  "event_type" VARCHAR(80) NOT NULL,
  "routing_key" VARCHAR(120) NOT NULL,
  "source_service" VARCHAR(60) NOT NULL,
  "entity_id" UUID NOT NULL,
  "entity_version" INTEGER NOT NULL,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "correlation_id" UUID NOT NULL,
  "payload" JSONB NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMPTZ(6),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "outbox_events_published_at_occurred_at_idx"
  ON "outbox_events"("published_at", "occurred_at");

CREATE TABLE IF NOT EXISTS "processed_events" (
  "event_id" UUID NOT NULL,
  "event_type" VARCHAR(80) NOT NULL,
  "source_service" VARCHAR(60) NOT NULL,
  "entity_id" UUID NOT NULL,
  "entity_version" INTEGER NOT NULL DEFAULT 0,
  "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);
CREATE INDEX IF NOT EXISTS "processed_events_source_service_entity_id_entity_version_idx"
  ON "processed_events"("source_service", "entity_id", "entity_version");
