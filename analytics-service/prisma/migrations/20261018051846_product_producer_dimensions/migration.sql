-- CreateTable
CREATE TABLE "product_facts" (
    "product_id" UUID NOT NULL,
    "producer_id" UUID,
    "name" VARCHAR(180) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "product_facts_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "producer_facts" (
    "producer_id" UUID NOT NULL,
    "full_name" VARCHAR(180),
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "producer_facts_pkey" PRIMARY KEY ("producer_id")
);
