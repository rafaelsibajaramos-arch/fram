import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Farm, Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth/jwt-auth.guard';
import { assertOwnership } from '../common/auth/ownership';
import { PrismaService } from '../prisma/prisma.service';
import { ProducersService } from '../producers/producers.service';
import { CreateFarmDto } from './dto/create-farm.dto';
import { QueryFarmsDto } from './dto/query-farms.dto';
import { UpdateFarmDto } from './dto/update-farm.dto';

export interface FarmView {
  id: string;
  producer_id: string;
  farm_name: string;
  address: string;
  latitude: number;
  longitude: number;
  active: boolean;
}

@Injectable()
export class FarmsService {
  private readonly logger = new Logger(FarmsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly producers: ProducersService,
  ) {}

  static toView(f: Farm): FarmView {
    return {
      id: f.id,
      producer_id: f.producerId,
      farm_name: f.farmName,
      address: f.address,
      latitude: Number(f.latitude),
      longitude: Number(f.longitude),
      active: f.active,
    };
  }

  async create(producerId: string, dto: CreateFarmDto, user: AuthUser): Promise<FarmView> {
    const producer = await this.producers.assertActive(producerId);
    assertOwnership(user, producer.userId, 'No puede crear fincas para otro productor');

    const farm = await this.prisma.farm.create({
      data: {
        producerId,
        farmName: dto.farm_name,
        address: dto.address,
        latitude: new Prisma.Decimal(dto.latitude),
        longitude: new Prisma.Decimal(dto.longitude),
      },
    });

    this.logger.log({ msg: 'farm_created', entity_id: farm.id, producer_id: producerId });
    return FarmsService.toView(farm);
  }

  async findByProducer(producerId: string, query: QueryFarmsDto): Promise<FarmView[]> {
    await this.producers.getOrThrow(producerId);
    const farms = await this.prisma.farm.findMany({
      where: { producerId, ...(query.active !== undefined ? { active: query.active } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return farms.map(FarmsService.toView);
  }

  async findOne(farmId: string): Promise<FarmView> {
    return FarmsService.toView(await this.getOrThrow(farmId));
  }

  async update(farmId: string, dto: UpdateFarmDto, user: AuthUser): Promise<FarmView> {
    const farm = await this.getOrThrow(farmId);
    const producer = await this.producers.getOrThrow(farm.producerId);
    assertOwnership(user, producer.userId, 'La finca no pertenece al usuario autenticado');

    const actualizada = await this.prisma.farm.update({
      where: { id: farmId },
      data: {
        ...(dto.farm_name !== undefined ? { farmName: dto.farm_name } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.latitude !== undefined ? { latitude: new Prisma.Decimal(dto.latitude) } : {}),
        ...(dto.longitude !== undefined ? { longitude: new Prisma.Decimal(dto.longitude) } : {}),
        version: { increment: 1 },
      },
    });

    return FarmsService.toView(actualizada);
  }

  /** Baja logica: la finca puede estar referenciada historicamente por lotes. */
  async setActive(farmId: string, active: boolean, user: AuthUser): Promise<FarmView> {
    const farm = await this.getOrThrow(farmId);
    const producer = await this.producers.getOrThrow(farm.producerId);
    assertOwnership(user, producer.userId, 'La finca no pertenece al usuario autenticado');
    if (farm.active === active) return FarmsService.toView(farm);

    const actualizada = await this.prisma.farm.update({
      where: { id: farmId },
      data: { active, version: { increment: 1 } },
    });
    return FarmsService.toView(actualizada);
  }

  async getOrThrow(farmId: string): Promise<Farm> {
    const farm = await this.prisma.farm.findUnique({ where: { id: farmId } });
    if (!farm) throw new NotFoundException('Finca inexistente');
    return farm;
  }

  /** Respuesta del endpoint interno consumido por catalog-service. */
  async validate(farmId: string): Promise<{
    farm_id: string;
    exists: boolean;
    active: boolean;
    producer_id: string | null;
    producer_active: boolean;
  }> {
    const farm = await this.prisma.farm.findUnique({
      where: { id: farmId },
      select: { id: true, active: true, producerId: true, producer: { select: { status: true } } },
    });

    return {
      farm_id: farmId,
      exists: !!farm,
      active: farm?.active ?? false,
      producer_id: farm?.producerId ?? null,
      producer_active: farm?.producer.status === 'active',
    };
  }
}
