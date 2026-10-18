-- Completa el sobre de eventos y permite reclamarlos de forma segura entre réplicas.
ALTER TABLE "payment_outbox_events"
  ADD COLUMN "correlation_id" UUID,
  ADD COLUMN "entity_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "schema_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "last_error" TEXT,
  ADD COLUMN "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "locked_until" TIMESTAMP(3);

-- Los eventos históricos conservan un identificador de correlación determinista.
UPDATE "payment_outbox_events"
SET "correlation_id" = "id"
WHERE "correlation_id" IS NULL;

UPDATE "payment_outbox_events"
SET "entity_version" = CASE WHEN "eventType" = 'payment.refunded' THEN 2 ELSE 1 END;

ALTER TABLE "payment_outbox_events"
  ALTER COLUMN "correlation_id" SET NOT NULL;

DROP INDEX IF EXISTS "payment_outbox_events_publishedAt_createdAt_idx";
CREATE INDEX "payment_outbox_events_delivery_idx"
  ON "payment_outbox_events" ("publishedAt", "available_at", "createdAt");
