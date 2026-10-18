import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { EventEnvelope } from './event-envelope';
import { RabbitService } from './rabbit.service';

interface OutboxRow {
  id: string; eventType: string; aggregateId: string; routingKey: string | null;
  sourceService: string; entityVersion: number; schemaVersion: number;
  correlationId: string; occurredAt: Date; payload: Prisma.JsonValue;
}

/** Publica de forma durable los eventos creados en la misma transacción del pedido. */
@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly pollMs = Math.max(500, Number(process.env.OUTBOX_POLL_MS ?? 3000));
  private readonly batchSize = Math.min(200, Math.max(1, Number(process.env.OUTBOX_BATCH_SIZE ?? 50)));

  constructor(private readonly prisma: PrismaService, private readonly rabbit: RabbitService) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.OUTBOX_PUBLISHER_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.drain(), this.pollMs);
    this.timer.unref?.();
    void this.drain();
  }

  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async drain(): Promise<number> {
    if (this.running || !this.rabbit.isConnected()) return 0;
    this.running = true;
    let published = 0;
    try {
      // Claim rows atomically and briefly lease them so multiple Railway replicas
      // do not publish the same batch at once. A crashed worker becomes retryable.
      const rows = await this.prisma.$transaction((tx) => tx.$queryRaw<OutboxRow[]>`
        UPDATE "order_outbox_events"
           SET "availableAt" = NOW() + INTERVAL '1 minute'
         WHERE "id" IN (
           SELECT "id" FROM "order_outbox_events"
            WHERE "status" = 'pending' AND "availableAt" <= NOW()
            ORDER BY "createdAt" ASC LIMIT ${this.batchSize}
            FOR UPDATE SKIP LOCKED
         )
        RETURNING "id", "eventType", "aggregateId", "routingKey", "sourceService",
                  "entityVersion", "schemaVersion", "correlationId", "occurredAt", "payload"
      `);
      for (const row of rows) {
        const envelope: EventEnvelope = {
          event_id: row.id, event_type: row.eventType, source_service: row.sourceService,
          entity_id: row.aggregateId, entity_version: row.entityVersion,
          schema_version: row.schemaVersion, occurred_at: row.occurredAt.toISOString(),
          correlation_id: row.correlationId, payload: row.payload as Record<string, unknown>,
        };
        try {
          await this.rabbit.publish(row.routingKey ?? row.eventType, envelope);
          await this.prisma.outboxEvent.update({ where: { id: row.id }, data: { status: 'published', publishedAt: new Date() } });
          published++;
        } catch (error) {
          const attempts = await this.prisma.outboxEvent.findUnique({ where: { id: row.id }, select: { attempts: true } });
          const nextAttempt = (attempts?.attempts ?? 0) + 1;
          const delaySeconds = Math.min(900, 2 ** Math.min(nextAttempt, 9));
          await this.prisma.outboxEvent.update({ where: { id: row.id }, data: {
            attempts: { increment: 1 }, status: nextAttempt >= 12 ? 'failed' : 'pending',
            availableAt: new Date(Date.now() + delaySeconds * 1000),
          } });
          this.logger.error(`No se pudo publicar ${row.eventType} (${row.id}); intento ${nextAttempt}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      this.logger.error(`Error leyendo el outbox de pedidos: ${(error as Error).message}`);
    } finally { this.running = false; }
    return published;
  }
}
