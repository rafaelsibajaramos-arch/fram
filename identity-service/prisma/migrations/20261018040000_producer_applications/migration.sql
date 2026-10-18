CREATE TYPE "ProducerApplicationStatus" AS ENUM ('pending', 'approved', 'rejected');

CREATE TABLE "solicitudes_productor" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "business_name" VARCHAR(150) NOT NULL,
    "phone" VARCHAR(25),
    "message" VARCHAR(1000),
    "status" "ProducerApplicationStatus" NOT NULL DEFAULT 'pending',
    "review_notes" VARCHAR(1000),
    "reviewed_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewed_at" TIMESTAMPTZ(6),

    CONSTRAINT "solicitudes_productor_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "solicitudes_productor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "solicitudes_productor_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "solicitudes_productor_user_id_status_created_at_idx" ON "solicitudes_productor"("user_id", "status", "created_at");
CREATE INDEX "solicitudes_productor_status_created_at_idx" ON "solicitudes_productor"("status", "created_at");
CREATE UNIQUE INDEX "solicitudes_productor_one_pending_per_user" ON "solicitudes_productor"("user_id") WHERE "status" = 'pending';
