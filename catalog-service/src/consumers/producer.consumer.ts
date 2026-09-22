import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CONSUMED_EVENTS, EventEnvelope } from '../events/event-envelope';
import { RabbitService } from '../events/rabbit.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProductsService } from '../products/products.service';

const QUEUE = 'catalog-service.producers';

/**
 * Mantiene la copia local del estado de los productores (producer_refs) y
 * retira de la oferta los productos de un productor deshabilitado.
 * Los productos NO se borran: los pedidos existentes siguen necesitando su historia.
 */
@Injectable()
export class ProducerConsumer implements OnModuleInit {
  private readonly logger = new Logger(ProducerConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitService,
    private readonly products: ProductsService,
  ) {}

  onModuleInit(): void {
    this.rabbit.register(
      QUEUE,
      [CONSUMED_EVENTS.producerCreated, CONSUMED_EVENTS.producerUpdated, CONSUMED_EVENTS.producerDisabled],
      (e) => this.handle(e),
    );
  }

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as Record<string, unknown>;
    const producerId = (payload?.producer_id as string) ?? envelope.entity_id;
    if (!producerId) {
      this.logger.warn(`${envelope.event_type} sin producer_id, se descarta`);
      return;
    }

    const retirados = await this.prisma.$transaction(async (tx) => {
      const yaProcesado = await tx.processedEvent.findUnique({ where: { eventId: envelope.event_id } });
      if (yaProcesado) return [];
      await tx.processedEvent.create({
        data: {
          eventId: envelope.event_id,
          eventType: envelope.event_type,
          sourceService: envelope.source_service,
          entityId: producerId,
          entityVersion: envelope.entity_version ?? 0,
        },
      });

      const ref = await tx.producerRef.findUnique({ where: { producerId } });
      // Un evento con version anterior a la conocida no puede revertir el estado.
      if (ref && envelope.entity_version > 0 && envelope.entity_version < ref.version) {
        this.logger.debug(`Evento de productor antiguo ignorado para ${producerId}`);
        return [];
      }

      const deshabilitado = envelope.event_type === CONSUMED_EVENTS.producerDisabled;
      const status = deshabilitado ? 'disabled' : ((payload.status as string) ?? ref?.status ?? 'active');

      await tx.producerRef.upsert({
        where: { producerId },
        create: {
          producerId,
          fullName: (payload.full_name as string) ?? null,
          status,
          version: envelope.entity_version ?? 0,
        },
        update: {
          ...(payload.full_name !== undefined ? { fullName: payload.full_name as string } : {}),
          status,
          version: envelope.entity_version ?? ref?.version ?? 0,
        },
      });

      if (!deshabilitado) return [];

      const ids = await this.products.disableAllByProducer(producerId, envelope.correlation_id, tx);
      this.logger.log({
        msg: 'productos_retirados_por_productor_deshabilitado',
        entity_id: producerId,
        count: ids.length,
        correlation_id: envelope.correlation_id,
      });
      return ids;
    });

    // Fuera de la transaccion: si se invalidara dentro, una lectura anterior al
    // commit volveria a cachear el producto todavia activo durante todo el TTL.
    if (retirados.length) await this.products.invalidarCache(retirados);
  }
}
