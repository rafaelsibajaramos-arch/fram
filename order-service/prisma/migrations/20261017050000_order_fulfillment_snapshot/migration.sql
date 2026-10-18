ALTER TABLE "order_items"
  ADD COLUMN "harvestBatchId" UUID,
  ADD COLUMN "farmId" UUID,
  ADD COLUMN "pickupAddress" TEXT,
  ADD COLUMN "pickupLatitude" DECIMAL(9,6),
  ADD COLUMN "pickupLongitude" DECIMAL(9,6);
