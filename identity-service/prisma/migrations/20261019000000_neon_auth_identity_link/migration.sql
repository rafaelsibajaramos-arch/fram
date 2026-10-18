ALTER TABLE "usuarios" ADD COLUMN "neon_auth_id" VARCHAR(255);
ALTER TABLE "usuarios" ADD COLUMN "neon_credential_ready" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "usuarios_neon_auth_id_key" ON "usuarios"("neon_auth_id");
