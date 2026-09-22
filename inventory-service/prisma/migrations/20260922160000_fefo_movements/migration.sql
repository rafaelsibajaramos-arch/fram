-- Inventario: procedencia/vencimiento para FEFO y trazabilidad de movimientos.
CREATE TYPE "InventoryItemStatus" AS ENUM ('available', 'blocked', 'expired', 'depleted');
CREATE TYPE "MovementType" AS ENUM ('entry', 'dispatch', 'waste', 'return');
CREATE TYPE "WasteReason" AS ENUM ('expiry', 'damage', 'cold_chain');

ALTER TABLE "inventario"
  ADD COLUMN "expiry_estimate" DATE NOT NULL DEFAULT DATE '9999-12-31',
  ADD COLUMN "status" "InventoryItemStatus" NOT NULL DEFAULT 'available';

CREATE INDEX "inventario_product_id_status_expiry_estimate_id_idx"
  ON "inventario" ("product_id", "status", "expiry_estimate", "id");

CREATE TABLE "movimientos_stock" (
  "id" UUID NOT NULL,
  "item_id" UUID NOT NULL,
  "movement_type" "MovementType" NOT NULL,
  "quantity_kg" DECIMAL(12,3) NOT NULL,
  "reason" "WasteReason",
  "source_operation_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "movimientos_stock_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "movimientos_stock_quantity_positive" CHECK ("quantity_kg" > 0),
  CONSTRAINT "movimientos_stock_reason_only_waste" CHECK (("movement_type" = 'waste') = ("reason" IS NOT NULL))
);

CREATE UNIQUE INDEX "movimientos_stock_source_operation_id_key" ON "movimientos_stock" ("source_operation_id");
CREATE INDEX "movimientos_stock_item_id_created_at_idx" ON "movimientos_stock" ("item_id", "created_at");
CREATE INDEX "movimientos_stock_movement_type_created_at_idx" ON "movimientos_stock" ("movement_type", "created_at");
ALTER TABLE "movimientos_stock" ADD CONSTRAINT "movimientos_stock_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "inventario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
