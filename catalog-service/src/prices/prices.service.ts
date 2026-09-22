import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PriceHistory, PriceReason, Prisma, Product } from '@prisma/client';
import { AppConfig } from '../common/config/configuration';
import { CacheKeys, CacheService } from '../cache/cache.service';
import { CATALOG_EVENTS } from '../events/event-envelope';
import { OutboxService, PrismaTx } from '../events/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { calcularPrecioDinamico, redondear } from './dynamic-price';

export interface CurrentPriceView {
  product_id: string;
  price: number;
  price_version_id: string;
  available_kg: number;
  stock_version: number;
  reason: string;
  valid_from: string;
}

export interface PriceVersionView {
  id: string;
  price: number;
  valid_from: string;
  valid_to: string | null;
  available_kg: number;
  stock_version: number;
  reason: string;
}

/**
 * El historial de precios es la autoridad sobre el precio vigente.
 * Nunca puede haber dos versiones con valid_to = NULL para el mismo producto.
 */
@Injectable()
export class PricesService {
  private readonly logger = new Logger(PricesService.name);
  private readonly cfg: AppConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly cache: CacheService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>('app');
  }

  static toView(v: PriceHistory): PriceVersionView {
    return {
      id: v.id,
      price: Number(v.price),
      valid_from: v.validFrom.toISOString(),
      valid_to: v.validTo ? v.validTo.toISOString() : null,
      available_kg: Number(v.availableKg),
      stock_version: Number(v.stockVersion),
      reason: v.reason,
    };
  }

  /** Primera version del precio, creada junto con el producto (reason = initial). */
  async createInitialVersion(tx: PrismaTx, product: Product, validFrom = new Date()): Promise<PriceHistory> {
    return tx.priceHistory.create({
      data: {
        productId: product.id,
        price: redondear(product.basePrice),
        validFrom,
        validTo: null,
        availableKg: new Prisma.Decimal(0),
        stockVersion: BigInt(0),
        reason: PriceReason.initial,
      },
    });
  }

  async getCurrent(productId: string): Promise<CurrentPriceView> {
    const cacheado = await this.cache.get<CurrentPriceView>(CacheKeys.price(productId));
    if (cacheado) return cacheado;

    // Marca tomada antes de leer: si llega una invalidacion mientras se arma la
    // vista, la escritura posterior en cache se descarta por obsoleta.
    const desde = this.cache.ahora();
    const vigente = await this.findCurrentVersion(this.prisma, productId);
    if (!vigente) throw new NotFoundException('El producto no tiene una version de precio vigente');

    const vista: CurrentPriceView = {
      product_id: productId,
      price: Number(vigente.price),
      price_version_id: vigente.id,
      available_kg: Number(vigente.availableKg),
      stock_version: Number(vigente.stockVersion),
      reason: vigente.reason,
      valid_from: vigente.validFrom.toISOString(),
    };

    await this.cache.set(CacheKeys.price(productId), vista, { desde });
    return vista;
  }

  async getHistory(productId: string): Promise<PriceVersionView[]> {
    const versiones = await this.prisma.priceHistory.findMany({
      where: { productId },
      orderBy: { validFrom: 'desc' },
    });
    return versiones.map(PricesService.toView);
  }

  async findCurrentVersion(client: PrismaTx | PrismaService, productId: string): Promise<PriceHistory | null> {
    return client.priceHistory.findFirst({ where: { productId, validTo: null } });
  }

  /**
   * Cierra la version vigente y abre una nueva, dentro de la transaccion recibida.
   * Si el precio no cambia, solo actualiza disponibilidad y stock_version.
   * Devuelve la version resultante y si hubo cambio de precio.
   */
  async applyVersion(
    tx: PrismaTx,
    params: {
      product: Product;
      price: Prisma.Decimal;
      reason: PriceReason;
      availableKg: Prisma.Decimal;
      stockVersion: bigint;
      correlationId: string;
      at?: Date;
    },
  ): Promise<{ version: PriceHistory; cambioPrecio: boolean }> {
    const ahora = params.at ?? new Date();
    const vigente = await this.findCurrentVersion(tx, params.product.id);
    const nuevoPrecio = redondear(params.price);

    if (vigente && vigente.price.equals(nuevoPrecio)) {
      // Sin cambio de precio: solo se refresca la disponibilidad conocida.
      const actualizada = await tx.priceHistory.update({
        where: { id: vigente.id },
        data: { availableKg: params.availableKg, stockVersion: params.stockVersion },
      });
      return { version: actualizada, cambioPrecio: false };
    }

    if (vigente) {
      // valid_to de la anterior == valid_from de la nueva: sin solapamiento ni huecos.
      await tx.priceHistory.update({ where: { id: vigente.id }, data: { validTo: ahora } });
    }

    const nueva = await tx.priceHistory.create({
      data: {
        productId: params.product.id,
        price: nuevoPrecio,
        validFrom: ahora,
        validTo: null,
        availableKg: params.availableKg,
        stockVersion: params.stockVersion,
        reason: params.reason,
      },
    });

    await this.outbox.enqueue(tx, {
      eventType: CATALOG_EVENTS.priceChanged,
      entityId: params.product.id,
      entityVersion: params.product.version,
      correlationId: params.correlationId,
      payload: {
        product_id: params.product.id,
        price_version_id: nueva.id,
        price: Number(nueva.price),
        previous_price: vigente ? Number(vigente.price) : null,
        available_kg: Number(nueva.availableKg),
        stock_version: Number(nueva.stockVersion),
        reason: nueva.reason,
      },
    });

    return { version: nueva, cambioPrecio: true };
  }

  /**
   * Recalcula el precio de un producto con el stock conocido.
   * Se usa tras inventory.stock_changed y tras cambiar base_price.
   */
  async recalcular(
    tx: PrismaTx,
    params: {
      product: Product;
      availableKg: Prisma.Decimal;
      stockVersion: bigint;
      correlationId: string;
      forzarRazon?: PriceReason;
      at?: Date;
    },
  ): Promise<{ version: PriceHistory; cambioPrecio: boolean }> {
    const calculado = calcularPrecioDinamico(
      {
        basePrice: params.product.basePrice,
        lowStockThreshold: params.product.lowStockThreshold,
        highStockThreshold: params.product.highStockThreshold,
        availableKg: params.availableKg,
      },
      { lowStockFactor: this.cfg.lowStockFactor, highStockFactor: this.cfg.highStockFactor },
    );

    return this.applyVersion(tx, {
      product: params.product,
      price: calculado.price,
      reason: params.forzarRazon ?? calculado.reason,
      availableKg: params.availableKg,
      stockVersion: params.stockVersion,
      correlationId: params.correlationId,
      at: params.at,
    });
  }
}
