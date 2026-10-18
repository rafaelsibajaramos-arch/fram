import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { DomainEvent, EventsService } from './events.service';

type ClaimedEvent = {
  id: string;
  eventType: string;
  aggregateId: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
  correlationId: string;
  entityVersion: number;
  schemaVersion: number;
  attempts: number;
};

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly db: PrismaService, private readonly events: EventsService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), 1000);
    void this.flush();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async flush(): Promise<void> {
    if (this.running || !this.events.isConnected()) return;
    this.running = true;
    try {
      const rows = await this.db.$queryRaw<ClaimedEvent[]>`
        WITH candidates AS (
          SELECT id
          FROM payment_outbox_events
          WHERE "publishedAt" IS NULL
            AND available_at <= NOW()
            AND (locked_until IS NULL OR locked_until <= NOW())
          ORDER BY "createdAt" ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 25
        )
        UPDATE payment_outbox_events AS outbox
        SET locked_until = NOW() + INTERVAL '60 seconds'
        FROM candidates
        WHERE outbox.id = candidates.id
        RETURNING outbox.id,
          outbox."eventType" AS "eventType",
          outbox."aggregateId" AS "aggregateId",
          outbox.payload,
          outbox."createdAt" AS "createdAt",
          outbox.correlation_id AS "correlationId",
          outbox.entity_version AS "entityVersion",
          outbox.schema_version AS "schemaVersion",
          outbox.attempts
      `;

      for (const row of rows) await this.deliver(row);
    } catch (error) {
      this.logger.error(`No se pudo procesar el outbox de pagos: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async deliver(row: ClaimedEvent): Promise<void> {
    const event: DomainEvent = {
      event_id: row.id,
      event_type: row.eventType,
      source_service: 'payment-service',
      entity_id: row.aggregateId,
      entity_version: row.entityVersion,
      schema_version: row.schemaVersion,
      occurred_at: row.createdAt.toISOString(),
      correlation_id: row.correlationId,
      payload: row.payload as Record<string, unknown>,
    };

    try {
      await this.events.publish(event);
      await this.db.outboxEvent.update({
        where: { id: row.id },
        data: { publishedAt: new Date(), attempts: { increment: 1 }, lastError: null, lockedUntil: null },
      });
    } catch (error) {
      const nextAttempt = row.attempts + 1;
      const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(row.attempts, 6));
      await this.db.outboxEvent.update({
        where: { id: row.id },
        data: {
          attempts: { increment: 1 },
          lastError: (error as Error).message.slice(0, 4000),
          availableAt: new Date(Date.now() + delayMs),
          lockedUntil: null,
        },
      });
      this.logger.warn(`Evento ${row.eventType} (${row.id}) reintentará; intento ${nextAttempt}`);
    }
  }
}
