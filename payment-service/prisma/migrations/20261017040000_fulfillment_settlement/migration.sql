ALTER TABLE "payments" ADD COLUMN "capturedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
UPDATE "payments" SET "capturedAmount" = "amount" WHERE "status" = 'captured';

CREATE TABLE "payment_processed_events" (
  "eventId" UUID NOT NULL,
  "eventType" VARCHAR(120) NOT NULL,
  "sourceService" VARCHAR(80) NOT NULL,
  "entityId" UUID NOT NULL,
  "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_processed_events_pkey" PRIMARY KEY ("eventId")
);
