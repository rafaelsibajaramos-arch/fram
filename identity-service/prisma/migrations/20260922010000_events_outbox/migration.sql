ALTER TABLE "outbox_events"
  ADD COLUMN IF NOT EXISTS "routing_key" VARCHAR(120) NOT NULL DEFAULT 'identity.user_disabled',
  ADD COLUMN IF NOT EXISTS "source_service" VARCHAR(60) NOT NULL DEFAULT 'identity-service',
  ADD COLUMN IF NOT EXISTS "entity_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "schema_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "correlation_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS "last_error" TEXT;
