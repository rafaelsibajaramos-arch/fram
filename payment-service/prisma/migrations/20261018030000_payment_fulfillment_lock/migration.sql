ALTER TABLE "payments" ADD COLUMN "fulfillmentRouteId" UUID;

CREATE INDEX "payments_fulfillmentRouteId_idx" ON "payments"("fulfillmentRouteId");
