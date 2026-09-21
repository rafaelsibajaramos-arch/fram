-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ProducerStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "CertificationStatus" AS ENUM ('valid', 'expired', 'revoked');

-- CreateTable
CREATE TABLE "productores" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "full_name" VARCHAR(150) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "phone" VARCHAR(25),
    "status" "ProducerStatus" NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "productores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fincas" (
    "id" UUID NOT NULL,
    "producer_id" UUID NOT NULL,
    "farm_name" VARCHAR(120) NOT NULL,
    "address" TEXT NOT NULL,
    "latitude" DECIMAL(9,6) NOT NULL,
    "longitude" DECIMAL(9,6) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fincas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "certificaciones" (
    "id" UUID NOT NULL,
    "producer_id" UUID NOT NULL,
    "type" VARCHAR(60) NOT NULL,
    "issue_date" DATE NOT NULL,
    "valid_until" DATE,
    "status" "CertificationStatus" NOT NULL DEFAULT 'valid',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "certificaciones_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "productores_user_id_key" ON "productores"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "productores_email_key" ON "productores"("email");

-- CreateIndex
CREATE INDEX "productores_status_idx" ON "productores"("status");

-- CreateIndex
CREATE INDEX "fincas_producer_id_active_idx" ON "fincas"("producer_id", "active");

-- CreateIndex
CREATE INDEX "certificaciones_producer_id_status_valid_until_idx" ON "certificaciones"("producer_id", "status", "valid_until");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_occurred_at_idx" ON "outbox_events"("published_at", "occurred_at");

-- CreateIndex
CREATE INDEX "processed_events_source_service_entity_id_entity_version_idx" ON "processed_events"("source_service", "entity_id", "entity_version");

-- AddForeignKey
ALTER TABLE "fincas" ADD CONSTRAINT "fincas_producer_id_fkey" FOREIGN KEY ("producer_id") REFERENCES "productores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "certificaciones" ADD CONSTRAINT "certificaciones_producer_id_fkey" FOREIGN KEY ("producer_id") REFERENCES "productores"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CheckConstraint: coordenadas validas (seccion 7)
ALTER TABLE "fincas"
  ADD CONSTRAINT "fincas_latitud_valida" CHECK ("latitude" >= -90 AND "latitude" <= 90),
  ADD CONSTRAINT "fincas_longitud_valida" CHECK ("longitude" >= -180 AND "longitude" <= 180);

-- CheckConstraint: valid_until >= issue_date (seccion 8)
ALTER TABLE "certificaciones"
  ADD CONSTRAINT "certificaciones_rango_fechas" CHECK ("valid_until" IS NULL OR "valid_until" >= "issue_date");
