import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../common/config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { EventEnvelope } from './event-envelope';
import { RabbitService } from './rabbit.service';

interface OutboxRow {
  id: string;
  event_type: string;
  routing_key: string;
  source_service: string;
  entity_id: string;
  entity_version: number;
  schema_version: number;
  correlation_id: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

/**
 * Lee la tabla OUTBOX y publica en RabbitMQ.
 * FOR UPDATE SKIP LOCKED permite correr varias replicas sin duplicar trabajo.
 */
@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private readonly cfg: AppConfig;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>('app');
  }

  onModuleInit(): void {
    if (this.cfg.nodeEnv === 'test') return;
    this.timer = setInterval(() => void this.drain(), this.cfg.outboxPollMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async drain(): Promise<number> {
    if (this.running || !this.rabbit.isConnected()) return 0;
    this.running = true;
    let publicados = 0;

    try {
      const rows = await this.prisma.$transaction(async (tx) => {
        return tx.$queryRawUnsafe<OutboxRow[]>(
          `SELECT id, event_type, routing_key, source_service, entity_id, entity_version,
                  schema_version, correlation_id, payload, occurred_at
             FROM outbox_events
            WHERE published_at IS NULL
            ORDER BY occurred_at ASC
            LIMIT $1
              FOR UPDATE SKIP LOCKED`,
          this.cfg.outboxBatchSize,
        );
      });

      for (const row of rows) {
        const envelope: EventEnvelope = {
          event_id: row.id,
          event_type: row.event_type,
          source_service: row.source_service,
          entity_id: row.entity_id,
          entity_version: row.entity_version,
          schema_version: row.schema_version,
          occurred_at: new Date(row.occurred_at).toISOString(),
          correlation_id: row.correlation_id,
          payload: row.payload,
        };

        try {
          await this.rabbit.publish(row.routing_key, envelope);
          await this.prisma.outboxEvent.update({
            where: { id: row.id },
            data: { publishedAt: new Date(), lastError: null },
          });
          publicados++;
        } catch (err) {
          await this.prisma.outboxEvent.update({
            where: { id: row.id },
            data: { attempts: { increment: 1 }, lastError: (err as Error).message.slice(0, 500) },
          });
          this.logger.error(`No se pudo publicar ${row.event_type} (${row.id}): ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.error(`Error leyendo el outbox: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }

    if (publicados > 0) this.logger.log(`Outbox: ${publicados} evento(s) publicado(s)`);
    return publicados;
  }
}
