-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('registered', 'published', 'closed');

-- CreateEnum
CREATE TYPE "PriceReason" AS ENUM ('initial', 'low_stock', 'normal_stock', 'high_stock', 'base_change');

-- CreateTable
CREATE TABLE "categorias" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "categorias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "productos" (
    "id" UUID NOT NULL,
    "producer_id" UUID NOT NULL,
    "name" VARCHAR(150) NOT NULL,
    "category_id" UUID NOT NULL,
    "unit" VARCHAR(8) NOT NULL DEFAULT 'kg',
    "min_order_quantity" DECIMAL(12,3) NOT NULL,
    "base_price" DECIMAL(14,2) NOT NULL,
    "low_stock_threshold" DECIMAL(12,3) NOT NULL,
    "high_stock_threshold" DECIMAL(12,3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "productos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lotes_de_cosecha" (
    "batch_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "farm_id" UUID NOT NULL,
    "producer_id" UUID NOT NULL,
    "harvest_date" DATE NOT NULL,
    "quantity_kg" DECIMAL(12,3) NOT NULL,
    "expiry_estimate" DATE NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'registered',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "lotes_de_cosecha_pkey" PRIMARY KEY ("batch_id")
);

-- CreateTable
CREATE TABLE "historial_de_precios" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "valid_from" TIMESTAMPTZ(6) NOT NULL,
    "valid_to" TIMESTAMPTZ(6),
    "available_kg" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "stock_version" BIGINT NOT NULL DEFAULT 0,
    "reason" "PriceReason" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historial_de_precios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_state" (
    "product_id" UUID NOT NULL,
    "stock_version" BIGINT NOT NULL DEFAULT 0,
    "available_kg" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "physical_kg" DECIMAL(12,3) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_state_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "producer_refs" (
    "producer_id" UUID NOT NULL,
    "full_name" VARCHAR(150),
    "status" VARCHAR(12) NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "producer_refs_pkey" PRIMARY KEY ("producer_id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "routing_key" VARCHAR(120) NOT NULL,
    "source_service" VARCHAR(60) NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_version" INTEGER NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "correlation_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "event_type" VARCHAR(80) NOT NULL,
    "source_service" VARCHAR(60) NOT NULL,
    "entity_id" UUID NOT NULL,
    "entity_version" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categorias_name_key" ON "categorias"("name");

-- CreateIndex
CREATE INDEX "productos_producer_id_active_idx" ON "productos"("producer_id", "active");

-- CreateIndex
CREATE INDEX "productos_category_id_active_idx" ON "productos"("category_id", "active");

-- CreateIndex
CREATE INDEX "lotes_de_cosecha_product_id_expiry_estimate_idx" ON "lotes_de_cosecha"("product_id", "expiry_estimate");

-- CreateIndex
CREATE INDEX "lotes_de_cosecha_farm_id_harvest_date_idx" ON "lotes_de_cosecha"("farm_id", "harvest_date");

-- CreateIndex
CREATE INDEX "lotes_de_cosecha_status_idx" ON "lotes_de_cosecha"("status");

-- CreateIndex
CREATE INDEX "historial_de_precios_product_id_valid_from_idx" ON "historial_de_precios"("product_id", "valid_from" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "historial_de_precios_product_id_valid_from_key" ON "historial_de_precios"("product_id", "valid_from");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_occurred_at_idx" ON "outbox_events"("published_at", "occurred_at");

-- CreateIndex
CREATE INDEX "processed_events_source_service_entity_id_entity_version_idx" ON "processed_events"("source_service", "entity_id", "entity_version");

-- AddForeignKey
ALTER TABLE "productos" ADD CONSTRAINT "productos_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categorias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lotes_de_cosecha" ADD CONSTRAINT "lotes_de_cosecha_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "historial_de_precios" ADD CONSTRAINT "historial_de_precios_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "productos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Una unica version de precio vigente por producto (seccion 18 y 29).
-- Prisma no expresa indices unicos parciales en el schema, por eso va aqui.
CREATE UNIQUE INDEX "historial_precios_una_version_vigente"
  ON "historial_de_precios" ("product_id")
  WHERE "valid_to" IS NULL;

-- CheckConstraint: reglas de negocio de PRODUCTOS (seccion 15 y 19.3)
ALTER TABLE "productos"
  ADD CONSTRAINT "productos_unidad_kg" CHECK ("unit" = 'kg'),
  ADD CONSTRAINT "productos_min_order_positivo" CHECK ("min_order_quantity" > 0),
  ADD CONSTRAINT "productos_base_price_positivo" CHECK ("base_price" > 0),
  ADD CONSTRAINT "productos_low_threshold_no_negativo" CHECK ("low_stock_threshold" >= 0),
  ADD CONSTRAINT "productos_umbrales_coherentes" CHECK ("high_stock_threshold" > "low_stock_threshold");

-- CheckConstraint: reglas de LOTES_DE_COSECHA (seccion 17)
ALTER TABLE "lotes_de_cosecha"
  ADD CONSTRAINT "lotes_cantidad_positiva" CHECK ("quantity_kg" > 0),
  ADD CONSTRAINT "lotes_vencimiento_coherente" CHECK ("expiry_estimate" >= "harvest_date");

-- CheckConstraint: reglas de HISTORIAL_DE_PRECIOS (seccion 18)
ALTER TABLE "historial_de_precios"
  ADD CONSTRAINT "precios_precio_positivo" CHECK ("price" > 0),
  ADD CONSTRAINT "precios_disponibilidad_no_negativa" CHECK ("available_kg" >= 0),
  ADD CONSTRAINT "precios_stock_version_no_negativa" CHECK ("stock_version" >= 0),
  ADD CONSTRAINT "precios_rango_coherente" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from");
