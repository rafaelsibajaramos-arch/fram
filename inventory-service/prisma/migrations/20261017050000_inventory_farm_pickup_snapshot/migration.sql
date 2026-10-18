ALTER TABLE "inventario"
  ADD COLUMN "farm_id" UUID,
  ADD COLUMN "pickup_address" TEXT,
  ADD COLUMN "pickup_latitude" DECIMAL(9,6),
  ADD COLUMN "pickup_longitude" DECIMAL(9,6);
