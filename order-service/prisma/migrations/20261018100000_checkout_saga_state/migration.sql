ALTER TABLE "orders"
  ADD COLUMN "checkoutInventoryStatus" VARCHAR(24) NOT NULL DEFAULT 'pending',
  ADD COLUMN "paymentId" UUID,
  ADD COLUMN "inventoryConsumed" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "orders_checkout_state_idx"
  ON "orders" ("status", "checkoutInventoryStatus", "paymentStatus");
