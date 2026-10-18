CREATE TYPE "NotificationChannel" AS ENUM ('email', 'sms', 'in_app');
CREATE TYPE "NotificationStatus" AS ENUM ('pending', 'sent', 'failed', 'read');

CREATE TABLE "notification_preferences" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "notification_type" VARCHAR(60) NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "notification_preferences_user_id_notification_type_channel_key" ON "notification_preferences"("user_id", "notification_type", "channel");
CREATE INDEX "notification_preferences_user_id_idx" ON "notification_preferences"("user_id");

CREATE TABLE "notifications" (
  "id" UUID NOT NULL,
  "preference_id" UUID,
  "user_id" UUID NOT NULL,
  "type" VARCHAR(60) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "message" TEXT NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "status" "NotificationStatus" NOT NULL DEFAULT 'pending',
  "source_event_id" UUID NOT NULL,
  "recipient_email" VARCHAR(254),
  "recipient_phone" VARCHAR(30),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at" TIMESTAMPTZ(6),
  "read_at" TIMESTAMPTZ(6),
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notifications_preference_id_fkey" FOREIGN KEY ("preference_id") REFERENCES "notification_preferences"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "notifications_sent_status_check" CHECK ("status" NOT IN ('sent', 'read') OR "sent_at" IS NOT NULL),
  CONSTRAINT "notifications_read_status_check" CHECK ("status" <> 'read' OR ("read_at" IS NOT NULL AND "read_at" >= "sent_at")),
  CONSTRAINT "notifications_sent_at_check" CHECK ("sent_at" IS NULL OR "sent_at" >= "created_at")
);
CREATE UNIQUE INDEX "notifications_source_event_id_user_id_channel_type_key" ON "notifications"("source_event_id", "user_id", "channel", "type");
CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at" DESC);
CREATE INDEX "notifications_status_next_attempt_at_idx" ON "notifications"("status", "next_attempt_at");

CREATE TABLE "processed_events" (
  "event_id" UUID NOT NULL,
  "event_type" VARCHAR(80) NOT NULL,
  "source_service" VARCHAR(40) NOT NULL,
  "entity_id" UUID NOT NULL,
  "entity_version" INTEGER NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB NOT NULL,
  "schema_version" INTEGER NOT NULL,
  "correlation_id" UUID NOT NULL,
  CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id"),
  CONSTRAINT "processed_events_entity_version_check" CHECK ("entity_version" > 0),
  CONSTRAINT "processed_events_schema_version_check" CHECK ("schema_version" > 0),
  CONSTRAINT "processed_events_payload_check" CHECK (jsonb_typeof("payload") = 'object')
);
CREATE UNIQUE INDEX "processed_events_source_service_event_type_entity_id_entity_version_key" ON "processed_events"("source_service", "event_type", "entity_id", "entity_version");
CREATE INDEX "processed_events_event_type_occurred_at_idx" ON "processed_events"("event_type", "occurred_at");
CREATE INDEX "processed_events_entity_id_idx" ON "processed_events"("entity_id");

CREATE TABLE "notification_outbox_events" (
  "id" UUID NOT NULL,
  "event_type" VARCHAR(80) NOT NULL,
  "aggregate_id" UUID NOT NULL,
  "routing_key" VARCHAR(120) NOT NULL,
  "entity_version" INTEGER NOT NULL DEFAULT 1,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "correlation_id" UUID NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_until" TIMESTAMPTZ(6),
  "published_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notification_outbox_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notification_outbox_entity_version_check" CHECK ("entity_version" > 0),
  CONSTRAINT "notification_outbox_schema_version_check" CHECK ("schema_version" > 0),
  CONSTRAINT "notification_outbox_payload_check" CHECK (jsonb_typeof("payload") = 'object')
);
CREATE INDEX "notification_outbox_events_published_at_available_at_idx" ON "notification_outbox_events"("published_at", "available_at");
