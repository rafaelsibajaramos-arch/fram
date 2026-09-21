import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PriceReason, Prisma, Product } from '@prisma/client';
import { CacheKeys, CacheService } from '../cache/cache.service';
import { CategoriesService } from '../categories/categories.service';
import { Paginated, paginate } from '../common/dto/pagination.dto';
import { CATALOG_EVENTS } from '../events/event-envelope';
import { OutboxService, PrismaTx } from '../events/outbox.service';
import { PricesService } from '../prices/prices.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProducerClientService } from '../producer-client/producer-client.service';
import { CreateProductDto, UNIDAD_UNICA } from './dto/create-product.dto';
import { QueryProductsDto } from './dto/query-products.dto';
import { UpdateProductDto } from './dto/update-product.dto';

export interface ProductView {
  id: string;
  producer_id: string;
  name: string;
  category: { id: string; name: string } | null;
  unit: string;
  min_order_quantity: number;
  base_price: number;
  low_stock_threshold: number;
  high_stock_threshold: number;
  active: boolean;
  price: number | null;
  price_version_id: string | null;
  available_kg: number;
  stock_version: number;
  producer_status: string | null;
}

type ProductConRelaciones = Prisma.ProductGetPayload<{
  include: { category: true; priceVersions: true };
}>;

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoriesService,
    private readonly producerClient: ProducerClientService,
    private readonly prices: PricesService,
    private readonly outbox: OutboxService,
    private readonly cache: CacheService,
  ) {}

  // ---------------------------------------------------------------- crear

  async create(dto: CreateProductDto, correlationId: string): Promise<ProductView> {
    if ((dto.unit ?? UNIDAD_UNICA) !== UNIDAD_UNICA) {
      throw new UnprocessableEntityException('unit solo puede ser kg');
    }
    assertUmbrales(dto.low_stock_threshold, dto.high_stock_threshold);

    // El productor se valida por REST; nunca se consulta producer_db.
    const productor = await this.producerClient.validateProducer(dto.producer_id, correlationId);
    if (!productor.exists) throw new NotFoundException('Productor inexistente');
    if (!productor.active) throw new ConflictException('El productor no esta activo');

    await this.categories.assertUsable(dto.category_id);

    // Producto + primera version de precio en la misma transaccion.
    const producto = await this.prisma.$transaction(async (tx) => {
      const creado = await tx.product.create({
        data: {
          producerId: dto.producer_id,
          name: dto.name,
          categoryId: dto.category_id,
          unit: UNIDAD_UNICA,
          minOrderQuantity: new Prisma.Decimal(dto.min_order_quantity),
          basePrice: new Prisma.Decimal(dto.base_price),
          lowStockThreshold: new Prisma.Decimal(dto.low_stock_threshold),
          highStockThreshold: new Prisma.Decimal(dto.high_stock_threshold),
        },
      });

      await this.prices.createInitialVersion(tx, creado);
      await tx.stockState.upsert({
        where: { productId: creado.id },
        create: { productId: creado.id },
        update: {},
      });

      await this.outbox.enqueue(tx, {
        eventType: CATALOG_EVENTS.productUpdated,
        entityId: creado.id,
        entityVersion: creado.version,
        correlationId,
        payload: {
          product_id: creado.id,
          producer_id: creado.producerId,
          name: creado.name,
          category_id: creado.categoryId,
          base_price: Number(creado.basePrice),
          active: creado.active,
        },
      });

      return creado;
    });

    await this.cache.del(CacheKeys.available());
    this.logger.log({ msg: 'product_created', entity_id: producto.id, correlation_id: correlationId });
    return this.findOne(producto.id);
  }

  // -------------------------------------------------------------- consultar

  async findOne(id: string): Promise<ProductView> {
    const cacheado = await this.cache.get<ProductView>(CacheKeys.product(id));
    if (cacheado) return cacheado;

    // Marca tomada antes de leer (ver CacheService).
    const desde = this.cache.ahora();
    const producto = await this.prisma.product.findUnique({
      where: { id },
      include: { category: true, priceVersions: { where: { validTo: null }, take: 1 } },
    });
    if (!producto) throw new NotFoundException('Producto inexistente');

    const vista = await this.toView(producto as ProductConRelaciones);
    await this.cache.set(CacheKeys.product(id), vista, { desde });
    return vista;
  }

  async findAll(query: QueryProductsDto): Promise<Paginated<ProductView>> {
    const where = this.buildWhere(query);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        include: { category: true, priceVersions: { where: { validTo: null }, take: 1 } },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.product.count({ where }),
    ]);

    const vistas = await Promise.all(rows.map((r) => this.toView(r as ProductConRelaciones)));
    return paginate(vistas, total, query.page, query.limit);
  }

  /**
   * GET /products/available.
   * La disponibilidad proviene de Inventario (inventory.stock_changed).
   * Nunca se inventa stock: si no ha llegado ningun evento, available_kg = 0.
   */
  async findAvailable(query: QueryProductsDto): Promise<Paginated<ProductView>> {
    const consulta = Object.assign(new QueryProductsDto(), query, { active: true, available: true });
    const esPrimeraPaginaSinFiltros =
      consulta.page === 1 && !consulta.producer_id && !consulta.category_id && !consulta.name;

    if (esPrimeraPaginaSinFiltros) {
      const cacheado = await this.cache.get<Paginated<ProductView>>(CacheKeys.available());
      if (cacheado) return cacheado;
    }

    const desde = this.cache.ahora();
    const resultado = await this.findAll(consulta);
    if (esPrimeraPaginaSinFiltros) {
      await this.cache.set(CacheKeys.available(), resultado, { desde });
    }
    return resultado;
  }

  // ------------------------------------------------------------- actualizar

  async update(id: string, dto: UpdateProductDto, correlationId: string): Promise<ProductView> {
    const actual = await this.getOrThrow(id);

    const low = dto.low_stock_threshold ?? Number(actual.lowStockThreshold);
    const high = dto.high_stock_threshold ?? Number(actual.highStockThreshold);
    assertUmbrales(low, high);

    if (dto.category_id && dto.category_id !== actual.categoryId) {
      await this.categories.assertUsable(dto.category_id);
    }

    const cambiaBasePrice = dto.base_price !== undefined && !actual.basePrice.equals(new Prisma.Decimal(dto.base_price));
    const cambianUmbrales =
      (dto.low_stock_threshold !== undefined && !actual.lowStockThreshold.equals(new Prisma.Decimal(low))) ||
      (dto.high_stock_threshold !== undefined && !actual.highStockThreshold.equals(new Prisma.Decimal(high)));

    await this.prisma.$transaction(async (tx) => {
      const producto = await tx.product.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.category_id !== undefined ? { categoryId: dto.category_id } : {}),
          ...(dto.min_order_quantity !== undefined
            ? { minOrderQuantity: new Prisma.Decimal(dto.min_order_quantity) }
            : {}),
          ...(dto.base_price !== undefined ? { basePrice: new Prisma.Decimal(dto.base_price) } : {}),
          ...(dto.low_stock_threshold !== undefined
            ? { lowStockThreshold: new Prisma.Decimal(dto.low_stock_threshold) }
            : {}),
          ...(dto.high_stock_threshold !== undefined
            ? { highStockThreshold: new Prisma.Decimal(dto.high_stock_threshold) }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          version: { increment: 1 },
        },
      });

      // Cambiar base_price crea una NUEVA version; jamas se edita una historica.
      if (cambiaBasePrice || cambianUmbrales) {
        const stock = await tx.stockState.findUnique({ where: { productId: id } });
        await this.prices.recalcular(tx, {
          product: producto,
          availableKg: stock?.availableKg ?? new Prisma.Decimal(0),
          stockVersion: stock?.stockVersion ?? BigInt(0),
          correlationId,
          forzarRazon: cambiaBasePrice ? PriceReason.base_change : undefined,
        });
      }

      await this.outbox.enqueue(tx, {
        eventType: CATALOG_EVENTS.productUpdated,
        entityId: producto.id,
        entityVersion: producto.version,
        correlationId,
        payload: {
          product_id: producto.id,
          producer_id: producto.producerId,
          name: producto.name,
          category_id: producto.categoryId,
          base_price: Number(producto.basePrice),
          active: producto.active,
        },
      });
    });

    await this.cache.invalidateProduct(id);
    return this.findOne(id);
  }

  /** Activar solo si el productor esta activo, la categoria es valida y los datos estan completos. */
  async enable(id: string, correlationId: string): Promise<ProductView> {
    const producto = await this.getOrThrow(id);
    if (producto.active) return this.findOne(id);

    const productor = await this.producerClient.validateProducer(producto.producerId, correlationId);
    if (!productor.exists) throw new NotFoundException('Productor inexistente');
    if (!productor.active) throw new ConflictException('El productor no esta activo');
    await this.categories.assertUsable(producto.categoryId);
    assertUmbrales(Number(producto.lowStockThreshold), Number(producto.highStockThreshold));

    await this.prisma.$transaction(async (tx) => {
      const actualizado = await tx.product.update({
        where: { id },
        data: { active: true, version: { increment: 1 } },
      });
      await this.outbox.enqueue(tx, {
        eventType: CATALOG_EVENTS.productAvailable,
        entityId: actualizado.id,
        entityVersion: actualizado.version,
        correlationId,
        payload: { product_id: actualizado.id, producer_id: actualizado.producerId },
      });
    });

    await this.cache.invalidateProduct(id);
    return this.findOne(id);
  }

  /** Baja logica: no se elimina el historial. */
  async disable(id: string, correlationId: string, motivo = 'manual'): Promise<ProductView> {
    const producto = await this.getOrThrow(id);
    if (!producto.active) return this.findOne(id);

    await this.prisma.$transaction(async (tx) => {
      const actualizado = await tx.product.update({
        where: { id },
        data: { active: false, version: { increment: 1 } },
      });
      await this.outbox.enqueue(tx, {
        eventType: CATALOG_EVENTS.productUnavailable,
        entityId: actualizado.id,
        entityVersion: actualizado.version,
        correlationId,
        payload: { product_id: actualizado.id, producer_id: actualizado.producerId, reason: motivo },
      });
    });

    await this.cache.invalidateProduct(id);
    return this.findOne(id);
  }

  // ----------------------------------------------------------------- apoyo

  async getOrThrow(id: string): Promise<Product> {
    const producto = await this.prisma.product.findUnique({ where: { id } });
    if (!producto) throw new NotFoundException('Producto inexistente');
    return producto;
  }

  async getActiveOrThrow(id: string): Promise<Product> {
    const producto = await this.getOrThrow(id);
    if (!producto.active) throw new ConflictException('El producto no esta activo');
    return producto;
  }

  private buildWhere(query: QueryProductsDto): Prisma.ProductWhereInput {
    const versionVigente: Prisma.PriceHistoryWhereInput = { validTo: null };

    if (query.min_price !== undefined || query.max_price !== undefined) {
      versionVigente.price = {
        ...(query.min_price !== undefined ? { gte: new Prisma.Decimal(query.min_price) } : {}),
        ...(query.max_price !== undefined ? { lte: new Prisma.Decimal(query.max_price) } : {}),
      };
    }
    if (query.available === true) versionVigente.availableKg = { gt: new Prisma.Decimal(0) };
    if (query.available === false) versionVigente.availableKg = { lte: new Prisma.Decimal(0) };

    const filtraPorVersion = Object.keys(versionVigente).length > 1;

    return {
      ...(query.producer_id ? { producerId: query.producer_id } : {}),
      ...(query.category_id ? { categoryId: query.category_id } : {}),
      ...(query.active !== undefined ? { active: query.active } : {}),
      ...(query.name ? { name: { contains: query.name, mode: 'insensitive' } } : {}),
      ...(filtraPorVersion ? { priceVersions: { some: versionVigente } } : {}),
    };
  }

  private async toView(p: ProductConRelaciones): Promise<ProductView> {
    const vigente = p.priceVersions?.find((v) => v.validTo === null) ?? null;
    const productorLocal = await this.prisma.producerRef.findUnique({ where: { producerId: p.producerId } });

    return {
      id: p.id,
      producer_id: p.producerId,
      name: p.name,
      category: p.category ? { id: p.category.id, name: p.category.name } : null,
      unit: p.unit,
      min_order_quantity: Number(p.minOrderQuantity),
      base_price: Number(p.basePrice),
      low_stock_threshold: Number(p.lowStockThreshold),
      high_stock_threshold: Number(p.highStockThreshold),
      active: p.active,
      price: vigente ? Number(vigente.price) : null,
      price_version_id: vigente?.id ?? null,
      available_kg: vigente ? Number(vigente.availableKg) : 0,
      stock_version: vigente ? Number(vigente.stockVersion) : 0,
      producer_status: productorLocal?.status ?? null,
    };
  }

  /**
   * Usado por el consumidor de producer.disabled.
   * Devuelve los ids afectados; la cache NO se invalida aqui porque este metodo
   * corre dentro de una transaccion: una lectura entre la invalidacion y el
   * commit volveria a cachear el estado viejo durante todo el TTL.
   * El llamador invalida despues del commit con invalidarCache().
   */
  async disableAllByProducer(producerId: string, correlationId: string, tx?: PrismaTx): Promise<string[]> {
    const client = tx ?? this.prisma;
    const productos = await client.product.findMany({ where: { producerId, active: true } });

    for (const producto of productos) {
      const actualizado = await client.product.update({
        where: { id: producto.id },
        data: { active: false, version: { increment: 1 } },
      });
      await this.outbox.enqueue(client as PrismaTx, {
        eventType: CATALOG_EVENTS.productUnavailable,
        entityId: actualizado.id,
        entityVersion: actualizado.version,
        correlationId,
        payload: { product_id: actualizado.id, producer_id: producerId, reason: 'producer_disabled' },
      });
    }

    return productos.map((p) => p.id);
  }

  /** Invalida la cache de varios productos. Se llama tras confirmar la transaccion. */
  async invalidarCache(productIds: string[]): Promise<void> {
    await Promise.all(productIds.map((id) => this.cache.invalidateProduct(id)));
  }
}

/** high_stock_threshold debe ser estrictamente mayor que low_stock_threshold. */
export function assertUmbrales(low: number, high: number): void {
  if (high <= low) {
    throw new UnprocessableEntityException('high_stock_threshold debe ser mayor que low_stock_threshold');
  }
}
