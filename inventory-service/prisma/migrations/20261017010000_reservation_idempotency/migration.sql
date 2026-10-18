-- Reservation retries must resolve to the original reservation instead of
-- decrementing stock again. Nullable keeps legacy/manual reservations valid.
ALTER TABLE "reservas_inventario"
  ADD COLUMN "idempotency_key" VARCHAR(180);

CREATE UNIQUE INDEX "reservas_inventario_idempotency_key_key"
  ON "reservas_inventario" ("idempotency_key");
