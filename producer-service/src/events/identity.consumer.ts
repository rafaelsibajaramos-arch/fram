import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../common/config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { CONSUMED_EVENTS, EventEnvelope, PRODUCER_EVENTS } from './event-envelope';
import { OutboxService } from './outbox.service';
import { RabbitService } from './rabbit.service';

const QUEUE = 'producer-service.identity';

/**
 * Consume identity.user_disabled:
 * buscar PRODUCTORES.user_id -> pasar a disabled -> publicar producer.disabled.
 * Todo de forma idempotente (processed_events).
 */
@Injectable()
export class IdentityConsumer implements OnModuleInit {
  private readonly logger = new Logger(IdentityConsumer.name);
  private readonly cfg: AppConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitService,
    private readonly outbox: OutboxService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>('app');
  }

  onModuleInit(): void {
    this.rabbit.register(QUEUE, [CONSUMED_EVENTS.identityUserDisabled], (e) => this.handle(e));
  }

  async handle(envelope: EventEnvelope): Promise<void> {
    const userId = (envelope.payload?.user_id as string) ?? envelope.entity_id;
    if (!userId) {
      this.logger.warn(`${envelope.event_type} sin user_id, se descarta`);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // Idempotencia: si el event_id ya fue procesado, no se repite el efecto.
      const yaProcesado = await tx.processedEvent.findUnique({ where: { eventId: envelope.event_id } });
      if (yaProcesado) {
        this.logger.debug(`Evento duplicado ignorado: ${envelope.event_id}`);
        return;
      }

      await tx.processedEvent.create({
        data: {
          eventId: envelope.event_id,
          eventType: envelope.event_type,
          sourceService: envelope.source_service,
          entityId: userId,
          entityVersion: envelope.entity_version ?? 0,
        },
      });

      const producer = await tx.producer.findUnique({ where: { userId } });
      if (!producer) {
        this.logger.log(`identity.user_disabled para user_id sin productor: ${userId}`);
        return;
      }
      if (producer.status === 'disabled') return;

      const actualizado = await tx.producer.update({
        where: { id: producer.id },
        data: { status: 'disabled', version: { increment: 1 } },
      });

      await this.outbox.enqueue(tx, {
        eventType: PRODUCER_EVENTS.disabled,
        entityId: actualizado.id,
        entityVersion: actualizado.version,
        correlationId: envelope.correlation_id,
        payload: {
          producer_id: actualizado.id,
          user_id: actualizado.userId,
          occurred_at: new Date().toISOString(),
        },
      });

      this.logger.log({
        msg: 'productor deshabilitado por Identity',
        producer_id: actualizado.id,
        correlation_id: envelope.correlation_id,
      });
    });
  }
}
