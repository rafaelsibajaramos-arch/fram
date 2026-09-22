ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'pending_email';
ALTER TYPE "UserStatus" ADD VALUE IF NOT EXISTS 'pending_invite';
CREATE TYPE "ActionTokenPurpose" AS ENUM ('email_verification', 'password_reset', 'invitation');

ALTER TABLE "usuarios"
  ADD COLUMN IF NOT EXISTS "roles_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMPTZ(6);

CREATE TABLE IF NOT EXISTS "sesiones" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "refresh_token_hash" VARCHAR(128) NOT NULL,
  "device_name" VARCHAR(120),
  "user_agent" VARCHAR(500),
  "ip_address" VARCHAR(64),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "last_used_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(6),
  "replaced_by_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sesiones_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "sesiones_refresh_token_hash_key" UNIQUE ("refresh_token_hash"),
  CONSTRAINT "sesiones_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "sesiones_user_id_revoked_at_idx" ON "sesiones"("user_id", "revoked_at");
CREATE INDEX IF NOT EXISTS "sesiones_expires_at_idx" ON "sesiones"("expires_at");

CREATE TABLE IF NOT EXISTS "tokens_accion" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "purpose" "ActionTokenPurpose" NOT NULL,
  "token_hash" VARCHAR(128) NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tokens_accion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tokens_accion_token_hash_key" UNIQUE ("token_hash"),
  CONSTRAINT "tokens_accion_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "tokens_accion_user_id_purpose_expires_at_idx" ON "tokens_accion"("user_id", "purpose", "expires_at");
