ALTER TABLE "order_outbox_events"
  ADD COLUMN "routingKey" VARCHAR(160),
  ADD COLUMN "sourceService" VARCHAR(80) NOT NULL DEFAULT 'order-service',
  ADD COLUMN "entityVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "correlationId" VARCHAR(180) NOT NULL DEFAULT gen_random_uuid()::text,
  ADD COLUMN "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "order_outbox_events_availableAt_idx"
  ON "order_outbox_events"("availableAt", "createdAt")
  WHERE "status" <> 'published';
