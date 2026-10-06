-- Las instalaciones anteriores crearon el esquema con db push; esta columna
-- completa la trazabilidad reserva -> item del pedido sin fallar en bases nuevas.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "reservationId" UUID;
