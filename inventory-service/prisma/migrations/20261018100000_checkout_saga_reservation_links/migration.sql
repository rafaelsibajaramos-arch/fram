ALTER TABLE "reservas_inventario"
  ADD COLUMN "order_id" UUID,
  ADD COLUMN "order_item_id" UUID;

CREATE INDEX "reservas_inventario_order_id_status_idx"
  ON "reservas_inventario" ("order_id", "status");
