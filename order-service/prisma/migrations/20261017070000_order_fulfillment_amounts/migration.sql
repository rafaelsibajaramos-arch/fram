ALTER TABLE "orders" ADD COLUMN "settledAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "order_items" ADD COLUMN "acceptedQuantity" DECIMAL(12,3);
ALTER TABLE "order_items" ADD COLUMN "acceptedSubtotal" DECIMAL(12,2);
