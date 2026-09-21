import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CacheService } from '../cache/cache.service';
import { CONSUMED_EVENTS, EventEnvelope } from '../events/event-envelope';
import { RabbitService } from '../events/rabbit.service';
import { PricesService } from '../prices/prices.service';
import { PrismaService } from '../prisma/prisma.service';

const QUEUE = 'catalog-service.inventory';

export interface StockChangedPayload {
  product_id: string;
  stock_version: number | string;
  available_kg: number | string;
  physical_kg?: number | string;
}

/**
 * Consume inventory.stock_changed y actualiza la disponibilidad publicada
 * del catalogo. El saldo real sigue perteneciendo a inventory_db.
 *
 * Regla anti-regresion: si stock_version <= ultima version procesada, se ignora.
 */
@Injectable()
export class InventoryConsumer implements OnModuleInit {
  private readonly logger = new Logger(InventoryConsumer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitService,
    private readonly prices: PricesService,
    private readonly cache: CacheService,
  ) {}

  onModuleInit(): void {
    this.rabbit.register(QUEUE, [CONSUMED_EVENTS.inventoryStockChanged], (e) => this.handle(e));
  }

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.payload as unknown as StockChangedPayload;
    const productId = payload?.product_id;
    if (!productId) {
      this.logger.warn(`${envelope.event_type} sin product_id, se descarta`);
      return;
    }

    const stockVersion = BigInt(payload.stock_version ?? 0);
    const availableKg = new Prisma.Decimal(payload.available_kg ?? 0);
    const physicalKg = new Prisma.Decimal(payload.physical_kg ?? payload.available_kg ?? 0);

    const cambio = await this.prisma.$transaction(async (tx) => {
      // Idempotencia por event_id (mensajes duplicados de RabbitMQ).
      const yaProcesado = await tx.processedEvent.findUnique({ where: { eventId: envelope.event_id } });
      if (yaProcesado) return false;
      await tx.processedEvent.create({
        data: {
          eventId: envelope.event_id,
          eventType: envelope.event_type,
          sourceService: envelope.source_service,
          entityId: productId,
          entityVersion: envelope.entity_version ?? 0,
        },
      });

      // Bloquea la fila del producto: serializa los cambios de version de precio.
      const bloqueado = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM productos WHERE id = ${productId}::uuid FOR UPDATE`;
      if (bloqueado.length === 0) {
        this.logger.warn(`stock_changed para un producto inexistente: ${productId}`);
        return false;
      }

      const estado = await tx.stockState.findUnique({ where: { productId } });
      // Eventos antiguos o repetidos no pueden devolver el catalogo a un stock viejo.
      if (estado && stockVersion <= estado.stockVersion) {
        this.logger.debug(
          `Evento de stock ignorado (v${stockVersion} <= v${estado.stockVersion}) para ${productId}`,
        );
        return false;
      }

      await tx.stockState.upsert({
        where: { productId },
        create: { productId, stockVersion, availableKg, physicalKg },
        update: { stockVersion, availableKg, physicalKg },
      });

      const producto = await tx.product.findUniqueOrThrow({ where: { id: productId } });
      const { cambioPrecio } = await this.prices.recalcular(tx, {
        product: producto,
        availableKg,
        stockVersion,
        correlationId: envelope.correlation_id,
      });

      this.logger.log({
        msg: 'stock_changed_procesado',
        entity_id: productId,
        stock_version: Number(stockVersion),
        available_kg: Number(availableKg),
        price_changed: cambioPrecio,
        correlation_id: envelope.correlation_id,
      });

      return true;
    });

    if (cambio) await this.cache.invalidateProduct(productId);
  }
}
