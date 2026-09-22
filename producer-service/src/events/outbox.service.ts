import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppConfig } from '../common/config/configuration';

export type PrismaTx = Prisma.TransactionClient;

export interface OutboxInput {
  eventType: string;
  entityId: string;
  entityVersion: number;
  payload: Record<string, unknown>;
  correlationId?: string;
  /** routing key de RabbitMQ; por defecto igual al eventType */
  routingKey?: string;
  schemaVersion?: number;
}

/**
 * Patron Outbox: guardar el cambio de negocio y el evento en la MISMA
 * transaccion. Un worker publica despues hacia RabbitMQ.
 */
@Injectable()
export class OutboxService {
  private readonly cfg: AppConfig;

  constructor(config: ConfigService) {
    this.cfg = config.getOrThrow<AppConfig>('app');
  }

  async enqueue(tx: PrismaTx, input: OutboxInput): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        eventType: input.eventType,
        routingKey: input.routingKey ?? input.eventType,
        sourceService: this.cfg.serviceName,
        entityId: input.entityId,
        entityVersion: input.entityVersion,
        schemaVersion: input.schemaVersion ?? 1,
        correlationId: input.correlationId ?? randomUUID(),
        payload: input.payload as Prisma.InputJsonValue,
      },
    });
  }
}
