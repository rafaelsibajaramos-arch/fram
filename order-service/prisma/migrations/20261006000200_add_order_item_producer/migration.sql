ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "producerId" UUID;

CREATE INDEX IF NOT EXISTS "order_items_producerId_idx"
  ON "order_items"("producerId");
