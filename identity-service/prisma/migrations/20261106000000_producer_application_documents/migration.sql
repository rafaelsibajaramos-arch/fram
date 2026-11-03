CREATE TABLE "solicitudes_productor_documentos" (
  "id" UUID NOT NULL,
  "application_id" UUID NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "file_name" VARCHAR(180) NOT NULL,
  "mime_type" VARCHAR(50) NOT NULL,
  "size" INTEGER NOT NULL,
  "content" BYTEA NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "solicitudes_productor_documentos_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "solicitudes_productor_documentos_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "solicitudes_productor"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "solicitudes_productor_documentos_kind_check" CHECK ("kind" IN ('cedula_frente', 'cedula_reverso', 'certificacion')),
  CONSTRAINT "solicitudes_productor_documentos_size_check" CHECK ("size" > 0 AND "size" <= 5242880)
);
CREATE INDEX "solicitudes_productor_documentos_application_id_kind_idx" ON "solicitudes_productor_documentos"("application_id", "kind");
CREATE UNIQUE INDEX "solicitudes_productor_documentos_unique_identity_side" ON "solicitudes_productor_documentos"("application_id", "kind") WHERE "kind" IN ('cedula_frente', 'cedula_reverso');
