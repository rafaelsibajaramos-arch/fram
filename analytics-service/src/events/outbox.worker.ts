import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { EventEnvelope } from '../event-envelope';
import { PrismaService } from '../prisma.service';
import { RabbitService } from './rabbit.service';

type Row = { id: string; eventType: string; aggregateId: string; entityVersion: number; correlationId: string; occurredAt: Date; payload: Prisma.JsonValue; attempts: number };
@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name); private timer?: NodeJS.Timeout; private running = false;
  constructor(private readonly db: PrismaService, private readonly rabbit: RabbitService) {}
  onModuleInit() { if (process.env.NODE_ENV === 'test') return; this.timer = setInterval(() => void this.flush(), Math.max(500, Number(process.env.OUTBOX_POLL_MS ?? 3000))); this.timer.unref?.(); void this.flush(); }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }
  async flush() {
    if (this.running || !this.rabbit.isConnected()) return; this.running = true;
    try {
      const rows = await this.db.$transaction((tx) => tx.$queryRaw<Row[]>`
        UPDATE analytics_outbox_events SET locked_until = NOW() + INTERVAL '60 seconds'
        WHERE id IN (SELECT id FROM analytics_outbox_events WHERE published_at IS NULL AND available_at <= NOW()
          AND (locked_until IS NULL OR locked_until <= NOW()) ORDER BY occurred_at LIMIT 50 FOR UPDATE SKIP LOCKED)
        RETURNING id, event_type AS "eventType", aggregate_id AS "aggregateId", entity_version AS "entityVersion", correlation_id AS "correlationId", occurred_at AS "occurredAt", payload, attempts
      `);
      for (const row of rows) {
        const event: EventEnvelope = { event_id: row.id, event_type: row.eventType, source_service: 'analytics-service', entity_id: row.aggregateId, entity_version: row.entityVersion, schema_version: 1, occurred_at: row.occurredAt.toISOString(), correlation_id: row.correlationId || randomUUID(), payload: row.payload as Record<string, unknown> };
        try { await this.rabbit.publish(event); await this.db.outboxEvent.update({ where: { id: row.id }, data: { publishedAt: new Date(), attempts: { increment: 1 }, lockedUntil: null } }); }
        catch { const attempts = row.attempts + 1; await this.db.outboxEvent.update({ where: { id: row.id }, data: { attempts, availableAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8))), lockedUntil: null } }); }
      }
    } catch (error) { this.logger.error(`Falló el outbox: ${(error as Error).message}`); }
    finally { this.running = false; }
  }
}
