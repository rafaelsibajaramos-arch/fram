CREATE TABLE payment_route_locks (
 id UUID PRIMARY KEY,
 "paymentId" UUID NOT NULL REFERENCES payments(id),
 "routeId" UUID NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE("paymentId", "routeId")
);
-- Existing dispatch locks remain valid. Their UUID is already unique per payment.
INSERT INTO payment_route_locks(id,"paymentId","routeId")
 SELECT id,id,"fulfillmentRouteId" FROM payments WHERE "fulfillmentRouteId" IS NOT NULL;
