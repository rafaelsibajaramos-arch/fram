-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "source_service" VARCHAR(80) NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_version" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "period_id" UUID NOT NULL,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "analytics_periods" (
    "id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "analytics_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_facts" (
    "order_id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,
    "payment_id" UUID,
    "ordered_at" TIMESTAMPTZ(6) NOT NULL,
    "captured_at" TIMESTAMPTZ(6),
    "captured_amount" DECIMAL(16,2),
    "refunded_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,

    CONSTRAINT "order_facts_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "fulfillment_line_facts" (
    "order_item_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "accepted_quantity_kg" DECIMAL(14,3) NOT NULL,
    "accepted_amount" DECIMAL(16,2) NOT NULL,

    CONSTRAINT "fulfillment_line_facts_pkey" PRIMARY KEY ("order_item_id")
);

-- CreateTable
CREATE TABLE "payment_facts" (
    "payment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "captured_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payment_facts_pkey" PRIMARY KEY ("payment_id")
);

-- CreateTable
CREATE TABLE "refund_facts" (
    "event_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "amount" DECIMAL(16,2) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "refund_facts_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "order_line_facts" (
    "order_item_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "producer_id" UUID,
    "product_name" VARCHAR(180),
    "quantity_kg" DECIMAL(14,3) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "accepted_quantity_kg" DECIMAL(14,3),
    "accepted_amount" DECIMAL(16,2),

    CONSTRAINT "order_line_facts_pkey" PRIMARY KEY ("order_item_id")
);

-- CreateTable
CREATE TABLE "waste_facts" (
    "movement_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "harvest_batch_id" UUID,
    "product_id" UUID NOT NULL,
    "quantity_kg" DECIMAL(14,3) NOT NULL,
    "reason" VARCHAR(20) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "waste_facts_pkey" PRIMARY KEY ("movement_id")
);

-- CreateTable
CREATE TABLE "harvest_facts" (
    "batch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "producer_id" UUID NOT NULL,
    "quantity_kg" DECIMAL(14,3) NOT NULL,
    "harvested_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "harvest_facts_pkey" PRIMARY KEY ("batch_id")
);

-- CreateTable
CREATE TABLE "report_facts" (
    "id" UUID NOT NULL,
    "report_type" VARCHAR(40) NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" JSONB NOT NULL,

    CONSTRAINT "report_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_facts" (
    "delivery_id" UUID NOT NULL,
    "order_id" UUID,
    "window_start" TIMESTAMPTZ(6) NOT NULL,
    "window_end" TIMESTAMPTZ(6) NOT NULL,
    "dispatched_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),
    "status" VARCHAR(12) NOT NULL,
    "cold_chain_incidents" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "delivery_facts_pkey" PRIMARY KEY ("delivery_id")
);

-- CreateTable
CREATE TABLE "delivery_status_facts" (
    "event_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "status" VARCHAR(12) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "dispatched_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "delivery_status_facts_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "cold_chain_facts" (
    "alert_id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "cold_chain_facts_pkey" PRIMARY KEY ("alert_id")
);

-- CreateTable
CREATE TABLE "rating_facts" (
    "rating_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "buyer_id" UUID NOT NULL,
    "score" INTEGER NOT NULL,
    "comment" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "rating_facts_pkey" PRIMARY KEY ("rating_id")
);

-- CreateTable
CREATE TABLE "stock_facts" (
    "lot_id" UUID NOT NULL,
    "stock_version" BIGINT NOT NULL,
    "product_id" UUID NOT NULL,
    "physical_kg" DECIMAL(14,3) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_facts_pkey" PRIMARY KEY ("lot_id","stock_version")
);

-- CreateTable
CREATE TABLE "movement_facts" (
    "movement_id" UUID NOT NULL,
    "lot_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "quantity_kg" DECIMAL(14,3) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "movement_facts_pkey" PRIMARY KEY ("movement_id")
);

-- CreateTable
CREATE TABLE "analytics_outbox_events" (
    "id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "entity_version" INTEGER NOT NULL DEFAULT 1,
    "correlation_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(6),
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "analytics_outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "processed_events_event_type_occurred_at_idx" ON "processed_events"("event_type", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "processed_events_source_service_event_type_entity_id_entity_key" ON "processed_events"("source_service", "event_type", "entity_id", "entity_version");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_periods_start_date_key" ON "analytics_periods"("start_date");

-- CreateIndex
CREATE INDEX "order_facts_captured_at_idx" ON "order_facts"("captured_at");

-- CreateIndex
CREATE INDEX "fulfillment_line_facts_order_id_idx" ON "fulfillment_line_facts"("order_id");

-- CreateIndex
CREATE INDEX "payment_facts_captured_at_order_id_idx" ON "payment_facts"("captured_at", "order_id");

-- CreateIndex
CREATE INDEX "refund_facts_occurred_at_order_id_idx" ON "refund_facts"("occurred_at", "order_id");

-- CreateIndex
CREATE INDEX "order_line_facts_product_id_idx" ON "order_line_facts"("product_id");

-- CreateIndex
CREATE INDEX "order_line_facts_producer_id_idx" ON "order_line_facts"("producer_id");

-- CreateIndex
CREATE UNIQUE INDEX "waste_facts_event_id_key" ON "waste_facts"("event_id");

-- CreateIndex
CREATE INDEX "waste_facts_occurred_at_product_id_idx" ON "waste_facts"("occurred_at", "product_id");

-- CreateIndex
CREATE INDEX "waste_facts_harvest_batch_id_idx" ON "waste_facts"("harvest_batch_id");

-- CreateIndex
CREATE INDEX "harvest_facts_harvested_at_product_id_idx" ON "harvest_facts"("harvested_at", "product_id");

-- CreateIndex
CREATE INDEX "report_facts_report_type_generated_at_idx" ON "report_facts"("report_type", "generated_at");

-- CreateIndex
CREATE INDEX "delivery_facts_window_end_status_idx" ON "delivery_facts"("window_end", "status");

-- CreateIndex
CREATE INDEX "delivery_status_facts_delivery_id_occurred_at_idx" ON "delivery_status_facts"("delivery_id", "occurred_at");

-- CreateIndex
CREATE INDEX "cold_chain_facts_delivery_id_idx" ON "cold_chain_facts"("delivery_id");

-- CreateIndex
CREATE UNIQUE INDEX "rating_facts_order_id_key" ON "rating_facts"("order_id");

-- CreateIndex
CREATE INDEX "rating_facts_created_at_score_idx" ON "rating_facts"("created_at", "score");

-- CreateIndex
CREATE INDEX "stock_facts_product_id_occurred_at_idx" ON "stock_facts"("product_id", "occurred_at");

-- CreateIndex
CREATE INDEX "movement_facts_type_occurred_at_idx" ON "movement_facts"("type", "occurred_at");

-- CreateIndex
CREATE INDEX "movement_facts_lot_id_occurred_at_idx" ON "movement_facts"("lot_id", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_outbox_events_published_at_available_at_idx" ON "analytics_outbox_events"("published_at", "available_at");

-- AddForeignKey
ALTER TABLE "processed_events" ADD CONSTRAINT "processed_events_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "analytics_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_facts" ADD CONSTRAINT "order_line_facts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "order_facts"("order_id") ON DELETE CASCADE ON UPDATE CASCADE;
