ALTER TYPE "OrderStatus" ADD VALUE IF NOT EXISTS 'partial';

CREATE TABLE "order_processed_events" (
  "eventId" UUID NOT NULL,
  "eventType" VARCHAR(120) NOT NULL,
  "sourceService" VARCHAR(80) NOT NULL,
  "entityId" UUID NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_processed_events_pkey" PRIMARY KEY ("eventId")
);
