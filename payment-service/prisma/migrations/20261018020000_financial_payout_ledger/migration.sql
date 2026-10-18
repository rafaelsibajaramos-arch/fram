CREATE TYPE "RefundStatus" AS ENUM ('pending', 'completed', 'failed');
CREATE TYPE "ProducerPayoutStatus" AS ENUM ('draft', 'scheduled', 'paid', 'failed', 'carried');

CREATE TABLE "charge_details" (
  "id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "order_item_id" UUID NOT NULL,
  "product_id" UUID NOT NULL,
  "product_name" VARCHAR(160) NOT NULL,
  "producer_name" VARCHAR(180),
  "producer_id" UUID NOT NULL,
  "ordered_quantity" DECIMAL(12,3) NOT NULL,
  "accepted_quantity" DECIMAL(12,3),
  "unit_price" DECIMAL(14,2) NOT NULL,
  "commission_rate" DECIMAL(7,6) NOT NULL,
  "gross_amount" DECIMAL(14,2),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "charge_details_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "charge_details_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "charge_details_ordered_quantity_check" CHECK ("ordered_quantity" > 0),
  CONSTRAINT "charge_details_accepted_quantity_check" CHECK ("accepted_quantity" IS NULL OR ("accepted_quantity" >= 0 AND "accepted_quantity" <= "ordered_quantity")),
  CONSTRAINT "charge_details_unit_price_check" CHECK ("unit_price" > 0),
  CONSTRAINT "charge_details_commission_rate_check" CHECK ("commission_rate" >= 0 AND "commission_rate" <= 1),
  CONSTRAINT "charge_details_gross_amount_check" CHECK ("gross_amount" IS NULL OR "gross_amount" >= 0)
);
CREATE UNIQUE INDEX "charge_details_payment_id_order_item_id_key" ON "charge_details"("payment_id", "order_item_id");
CREATE INDEX "charge_details_producer_id_idx" ON "charge_details"("producer_id");

CREATE TABLE "refunds" (
  "id" UUID NOT NULL,
  "charge_id" UUID NOT NULL,
  "order_item_id" UUID NOT NULL,
  "producer_id" UUID NOT NULL,
  "amount" DECIMAL(14,2) NOT NULL,
  "status" "RefundStatus" NOT NULL DEFAULT 'pending',
  "provider_reference" VARCHAR(120),
  "idempotency_key" VARCHAR(180) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refunds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refunds_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "refunds_amount_check" CHECK ("amount" > 0)
);
CREATE UNIQUE INDEX "refunds_provider_reference_key" ON "refunds"("provider_reference");
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds"("idempotency_key");
CREATE INDEX "refunds_charge_id_status_idx" ON "refunds"("charge_id", "status");
CREATE INDEX "refunds_order_item_id_status_idx" ON "refunds"("order_item_id", "status");

CREATE TABLE "producer_payouts" (
  "id" UUID NOT NULL,
  "producer_id" UUID NOT NULL,
  "period_start" DATE NOT NULL,
  "period_end" DATE NOT NULL,
  "gross_amount" DECIMAL(14,2) NOT NULL,
  "refund_amount" DECIMAL(14,2) NOT NULL,
  "commission_amount" DECIMAL(14,2) NOT NULL,
  "adjustment_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "net_amount" DECIMAL(14,2) NOT NULL,
  "status" "ProducerPayoutStatus" NOT NULL DEFAULT 'draft',
  "provider_reference" VARCHAR(120),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "producer_payouts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "producer_payouts_period_check" CHECK ("period_end" > "period_start"),
  CONSTRAINT "producer_payouts_nonnegative_totals_check" CHECK ("gross_amount" >= 0 AND "refund_amount" >= 0 AND "commission_amount" >= 0),
  CONSTRAINT "producer_payouts_net_amount_check" CHECK ("net_amount" = "gross_amount" - "refund_amount" - "commission_amount" + "adjustment_amount")
);
CREATE UNIQUE INDEX "producer_payouts_provider_reference_key" ON "producer_payouts"("provider_reference");
CREATE UNIQUE INDEX "producer_payouts_producer_id_period_start_period_end_key" ON "producer_payouts"("producer_id", "period_start", "period_end");
CREATE INDEX "producer_payouts_producer_id_status_idx" ON "producer_payouts"("producer_id", "status");

CREATE TABLE "producer_payout_items" (
  "id" UUID NOT NULL,
  "payout_id" UUID NOT NULL,
  "charge_id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "order_item_id" UUID NOT NULL,
  "gross_amount" DECIMAL(14,2) NOT NULL,
  "refund_amount" DECIMAL(14,2) NOT NULL,
  "commission_rate" DECIMAL(7,6) NOT NULL,
  "commission_amount" DECIMAL(14,2) NOT NULL,
  "net_amount" DECIMAL(14,2) NOT NULL,
  "charge_detail_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "producer_payout_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "producer_payout_items_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "producer_payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "producer_payout_items_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "producer_payout_items_charge_detail_id_fkey" FOREIGN KEY ("charge_detail_id") REFERENCES "charge_details"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "producer_payout_items_amounts_check" CHECK ("gross_amount" > 0 AND "refund_amount" >= 0 AND "refund_amount" <= "gross_amount" AND "commission_rate" >= 0 AND "commission_rate" <= 1 AND "commission_amount" >= 0 AND "net_amount" = "gross_amount" - "refund_amount" - "commission_amount")
);
CREATE UNIQUE INDEX "producer_payout_items_order_item_id_key" ON "producer_payout_items"("order_item_id");
CREATE UNIQUE INDEX "producer_payout_items_charge_detail_id_key" ON "producer_payout_items"("charge_detail_id");
CREATE INDEX "producer_payout_items_payout_id_idx" ON "producer_payout_items"("payout_id");
CREATE INDEX "producer_payout_items_charge_id_idx" ON "producer_payout_items"("charge_id");

CREATE TABLE "settlement_adjustments" (
  "id" UUID NOT NULL,
  "refund_id" UUID NOT NULL,
  "original_item_id" UUID NOT NULL,
  "payout_id" UUID,
  "amount" DECIMAL(14,2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "settlement_adjustments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "settlement_adjustments_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "settlement_adjustments_original_item_id_fkey" FOREIGN KEY ("original_item_id") REFERENCES "producer_payout_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "settlement_adjustments_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "producer_payouts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "settlement_adjustments_refund_id_key" ON "settlement_adjustments"("refund_id");
CREATE INDEX "settlement_adjustments_original_item_id_idx" ON "settlement_adjustments"("original_item_id");
CREATE INDEX "settlement_adjustments_payout_id_idx" ON "settlement_adjustments"("payout_id");
