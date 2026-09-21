import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { BatchStatus, HarvestBatch, Prisma } from '@prisma/client';
import { Paginated, paginate } from '../common/dto/pagination.dto';
import { CATALOG_EVENTS } from '../events/event-envelope';
import { OutboxService } from '../events/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProducerClientService } from '../producer-client/producer-client.service';
import { ProductsService } from '../products/products.service';
import { CreateHarvestBatchDto } from './dto/create-harvest-batch.dto';
import { QueryHarvestBatchesDto } from './dto/query-harvest-batches.dto';
import { UpdateHarvestBatchDto } from './dto/update-harvest-batch.dto';

export interface HarvestBatchView {
  batch_id: string;
  product_id: string;
  product_name?: string;
  farm_id: string;
  producer_id: string;
  harvest_date: string;
  quantity_kg: number;
  expiry_estimate: string;
  status: string;
}

@Injectable()
export class HarvestBatchesService {
  private readonly logger = new Logger(HarvestBatchesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly products: ProductsService,
    private readonly producerClient: ProducerClientService,
    private readonly outbox: OutboxService,
  ) {}

  static toView(b: HarvestBatch & { product?: { name: string } }): HarvestBatchView {
    return {
      batch_id: b.batchId,
      product_id: b.productId,
      ...(b.product ? { product_name: b.product.name } : {}),
      farm_id: b.farmId,
      producer_id: b.producerId,
      harvest_date: toDateString(b.harvestDate),
      quantity_kg: Number(b.quantityKg),
      expiry_estimate: toDateString(b.expiryEstimate),
      status: b.status,
    };
  }

  async create(dto: CreateHarvestBatchDto, correlationId: string): Promise<HarvestBatchView> {
    const harvestDate = parseDate(dto.harvest_date, 'harvest_date');
    const expiryEstimate = parseDate(dto.expiry_estimate, 'expiry_estimate');
    if (expiryEstimate.getTime() < harvestDate.getTime()) {
      throw new UnprocessableEntityException('expiry_estimate debe ser mayor o igual a harvest_date');
    }

    const producto = await this.products.getActiveOrThrow(dto.product_id);

    // El productor del producto debe seguir activo.
    const productor = await this.producerClient.validateProducer(producto.producerId, correlationId);
    if (!productor.exists) throw new NotFoundException('Productor inexistente');
    if (!productor.active) throw new ConflictException('El productor del producto no esta activo');

    // La finca debe existir, estar activa y pertenecer al productor del producto.
    const finca = await this.producerClient.validateFarm(dto.farm_id, correlationId);
    if (!finca.exists) throw new NotFoundException('Finca inexistente');
    if (!finca.active) throw new ConflictException('La finca no esta activa');
    if (finca.producer_id !== producto.producerId) {
      throw new ConflictException('La finca no pertenece al productor del producto');
    }

    const lote = await this.prisma.harvestBatch.create({
      data: {
        productId: producto.id,
        farmId: dto.farm_id,
        producerId: producto.producerId,
        harvestDate,
        quantityKg: new Prisma.Decimal(dto.quantity_kg),
        expiryEstimate,
        status: BatchStatus.registered,
      },
    });

    this.logger.log({ msg: 'harvest_batch_registered', entity_id: lote.batchId, correlation_id: correlationId });
    return HarvestBatchesService.toView(lote);
  }

  async findAll(query: QueryHarvestBatchesDto): Promise<Paginated<HarvestBatchView>> {
    const where: Prisma.HarvestBatchWhereInput = {
      ...(query.product_id ? { productId: query.product_id } : {}),
      ...(query.farm_id ? { farmId: query.farm_id } : {}),
      ...(query.status ? { status: query.status as BatchStatus } : {}),
      ...(query.harvest_date ? { harvestDate: parseDate(query.harvest_date, 'harvest_date') } : {}),
      ...(query.expiry_estimate
        ? { expiryEstimate: { lte: parseDate(query.expiry_estimate, 'expiry_estimate') } }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.harvestBatch.findMany({
        where,
        orderBy: { harvestDate: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.harvestBatch.count({ where }),
    ]);

    return paginate(rows.map((r) => HarvestBatchesService.toView(r)), total, query.page, query.limit);
  }

  /** La direccion de la finca no se duplica dentro del catalogo: solo su id. */
  async findOne(batchId: string): Promise<HarvestBatchView> {
    const lote = await this.prisma.harvestBatch.findUnique({
      where: { batchId },
      include: { product: { select: { name: true } } },
    });
    if (!lote) throw new NotFoundException('Lote inexistente');
    return HarvestBatchesService.toView(lote);
  }

  async update(batchId: string, dto: UpdateHarvestBatchDto): Promise<HarvestBatchView> {
    const lote = await this.getOrThrow(batchId);
    if (lote.status === BatchStatus.closed) {
      throw new ConflictException('Un lote cerrado no se puede modificar');
    }

    const harvestDate = dto.harvest_date ? parseDate(dto.harvest_date, 'harvest_date') : lote.harvestDate;
    const expiryEstimate = dto.expiry_estimate
      ? parseDate(dto.expiry_estimate, 'expiry_estimate')
      : lote.expiryEstimate;
    if (expiryEstimate.getTime() < harvestDate.getTime()) {
      throw new UnprocessableEntityException('expiry_estimate debe ser mayor o igual a harvest_date');
    }

    const actualizado = await this.prisma.harvestBatch.update({
      where: { batchId },
      data: {
        harvestDate,
        expiryEstimate,
        ...(dto.quantity_kg !== undefined ? { quantityKg: new Prisma.Decimal(dto.quantity_kg) } : {}),
        version: { increment: 1 },
      },
    });
    return HarvestBatchesService.toView(actualizado);
  }

  /**
   * Publicar el lote: valida de nuevo producto, productor y finca, cambia el
   * estado y encola harvest.registered en la misma transaccion.
   */
  async publish(batchId: string, correlationId: string): Promise<HarvestBatchView> {
    const lote = await this.getOrThrow(batchId);
    if (lote.status === BatchStatus.published) return HarvestBatchesService.toView(lote);
    if (lote.status === BatchStatus.closed) {
      throw new ConflictException('Un lote cerrado no se puede publicar');
    }

    const producto = await this.products.getActiveOrThrow(lote.productId);

    const productor = await this.producerClient.validateProducer(producto.producerId, correlationId);
    if (!productor.active) throw new ConflictException('El productor no esta activo');

    const finca = await this.producerClient.validateFarm(lote.farmId, correlationId);
    // Si la finca no puede validarse, el lote no se publica.
    if (!finca.exists || !finca.active) throw new ConflictException('La finca no es valida para publicar el lote');
    if (finca.producer_id !== producto.producerId) {
      throw new ConflictException('La finca no pertenece al productor del producto');
    }

    const publicado = await this.prisma.$transaction(async (tx) => {
      const actualizado = await tx.harvestBatch.update({
        where: { batchId },
        data: { status: BatchStatus.published, version: { increment: 1 } },
      });

      await this.outbox.enqueue(tx, {
        eventType: CATALOG_EVENTS.harvestRegistered,
        entityId: actualizado.batchId,
        entityVersion: actualizado.version,
        correlationId,
        payload: {
          batch_id: actualizado.batchId,
          product_id: actualizado.productId,
          producer_id: actualizado.producerId,
          farm_id: actualizado.farmId,
          harvest_date: toDateString(actualizado.harvestDate),
          quantity_kg: Number(actualizado.quantityKg),
          expiry_estimate: toDateString(actualizado.expiryEstimate),
        },
      });

      return actualizado;
    });

    this.logger.log({ msg: 'harvest_registered', entity_id: batchId, correlation_id: correlationId });
    return HarvestBatchesService.toView(publicado);
  }

  /** Cerrar no borra el lote: deja de considerarse una oferta nueva. */
  async close(batchId: string): Promise<HarvestBatchView> {
    const lote = await this.getOrThrow(batchId);
    if (lote.status === BatchStatus.closed) return HarvestBatchesService.toView(lote);

    const cerrado = await this.prisma.harvestBatch.update({
      where: { batchId },
      data: { status: BatchStatus.closed, version: { increment: 1 } },
    });
    return HarvestBatchesService.toView(cerrado);
  }

  async getOrThrow(batchId: string): Promise<HarvestBatch> {
    const lote = await this.prisma.harvestBatch.findUnique({ where: { batchId } });
    if (!lote) throw new NotFoundException('Lote inexistente');
    return lote;
  }
}

export function parseDate(value: string, campo: string): Date {
  const fecha = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(fecha.getTime())) {
    throw new UnprocessableEntityException(`${campo} no es una fecha valida`);
  }
  return fecha;
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}
