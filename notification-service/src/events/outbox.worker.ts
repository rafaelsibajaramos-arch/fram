import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { EventEnvelope } from '../event-envelope';
import { RabbitService } from './rabbit.service';

type OutboxRow = { id: string; eventType: string; aggregateId: string; entityVersion: number; schemaVersion: number; correlationId: string; occurredAt: Date; payload: Prisma.JsonValue; attempts: number };

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly prisma: PrismaService, private readonly rabbit: RabbitService) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.flush(), Math.max(500, Number(process.env.OUTBOX_POLL_MS ?? 3000)));
    this.timer.unref?.(); void this.flush();
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  async flush() {
    if (this.running || !this.rabbit.isConnected()) return;
    this.running = true;
    try {
      const rows = await this.prisma.$transaction((tx) => tx.$queryRaw<OutboxRow[]>`
        UPDATE notification_outbox_events SET locked_until = NOW() + INTERVAL '60 seconds'
        WHERE id IN (SELECT id FROM notification_outbox_events WHERE published_at IS NULL AND available_at <= NOW()
          AND (locked_until IS NULL OR locked_until <= NOW()) ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED)
        RETURNING id, event_type AS "eventType", aggregate_id AS "aggregateId", entity_version AS "entityVersion",
          schema_version AS "schemaVersion", correlation_id AS "correlationId", occurred_at AS "occurredAt", payload, attempts
      `);
      for (const row of rows) await this.publish(row);
    } catch (error) { this.logger.error(`Falló el outbox: ${(error as Error).message}`); }
    finally { this.running = false; }
  }

  private async publish(row: OutboxRow) {
    const event: EventEnvelope = { event_id: row.id, event_type: row.eventType, source_service: 'notification-service', entity_id: row.aggregateId, entity_version: row.entityVersion, schema_version: row.schemaVersion, occurred_at: row.occurredAt.toISOString(), correlation_id: row.correlationId || randomUUID(), payload: row.payload as Record<string, unknown> };
    try {
      await this.rabbit.publish(event);
      await this.prisma.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: new Date(), attempts: { increment: 1 }, lastError: null, lockedUntil: null } });
    } catch (error) {
      const attempts = row.attempts + 1;
      const delay = Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8));
      await this.prisma.outboxEvent.update({ where: { id: row.id }, data: { attempts, lastError: (error as Error).message.slice(0, 4000), availableAt: new Date(Date.now() + delay), lockedUntil: null } });
    }
  }
}
