import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Producer, Prisma } from '@prisma/client';
import { AuthUser } from '../common/auth/jwt-auth.guard';
import { assertOwnership, isAdmin } from '../common/auth/ownership';
import { Paginated, paginate } from '../common/dto/pagination.dto';
import { PRODUCER_EVENTS } from '../events/event-envelope';
import { OutboxService } from '../events/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProducerDto } from './dto/create-producer.dto';
import { QueryProducersDto } from './dto/query-producers.dto';
import { UpdateProducerDto } from './dto/update-producer.dto';

/** Vista publica del productor: nunca expone datos sensibles de Identity. */
export interface ProducerView {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  status: string;
  created_at: string;
}

@Injectable()
export class ProducersService {
  private readonly logger = new Logger(ProducersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  static toView(p: Producer): ProducerView {
    return {
      id: p.id,
      full_name: p.fullName,
      email: p.email,
      phone: p.phone,
      status: p.status,
      created_at: p.createdAt.toISOString(),
    };
  }

  async create(dto: CreateProducerDto, user: AuthUser, correlationId: string): Promise<ProducerView> {
    // La cuenta de Identity se demuestra con el propio JWT: solo el dueno del
    // user_id (o un admin) puede crear ese perfil de productor.
    if (!isAdmin(user) && user.sub !== dto.user_id) {
      throw new ForbiddenException('El user_id no corresponde a la cuenta autenticada');
    }

    const existente = await this.prisma.producer.findFirst({
      where: { OR: [{ userId: dto.user_id }, { email: dto.email }] },
      select: { userId: true, email: true },
    });
    if (existente) {
      throw new ConflictException(
        existente.userId === dto.user_id
          ? 'El user_id ya tiene un perfil de productor'
          : 'El email ya esta registrado',
      );
    }

    const creado = await this.prisma.$transaction(async (tx) => {
      const producer = await tx.producer.create({
        data: {
          userId: dto.user_id,
          fullName: dto.full_name,
          email: dto.email,
          phone: dto.phone ?? null,
        },
      });

      await this.outbox.enqueue(tx, {
        eventType: PRODUCER_EVENTS.created,
        entityId: producer.id,
        entityVersion: producer.version,
        correlationId,
        payload: {
          producer_id: producer.id,
          user_id: producer.userId,
          full_name: producer.fullName,
          status: producer.status,
        },
      });

      return producer;
    });

    this.logger.log({ msg: 'producer_created', entity_id: creado.id, correlation_id: correlationId });
    return ProducersService.toView(creado);
  }

  async findAll(query: QueryProducersDto, user: AuthUser): Promise<Paginated<ProducerView>> {
    const where: Prisma.ProducerWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      // El listado general es administrativo. Un productor autenticado solo
      // recibe su propio perfil, incluso si llama esta ruta manualmente.
      ...(!isAdmin(user) ? { userId: user.sub } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.producer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.producer.count({ where }),
    ]);

    return paginate(rows.map(ProducersService.toView), total, query.page, query.limit);
  }

  async findOne(id: string, user: AuthUser): Promise<ProducerView> {
    const producer = await this.getOrThrow(id);
    assertOwnership(user, producer.userId, 'No puede consultar el perfil de otro productor');
    return ProducersService.toView(producer);
  }

  async findByUserId(userId: string, user: AuthUser): Promise<ProducerView> {
    if (!isAdmin(user) && userId !== user.sub) {
      throw new ForbiddenException('No puede consultar el perfil de otro productor');
    }
    const producer = await this.prisma.producer.findUnique({ where: { userId } });
    if (!producer) throw new NotFoundException('No existe un productor para ese user_id');
    return ProducersService.toView(producer);
  }

  /** Consulta interna de propiedad para otros servicios; no expone datos de perfil. */
  async idByUserId(userId: string): Promise<{ producer_id: string | null }> {
    const producer = await this.prisma.producer.findUnique({ where: { userId }, select: { id: true } });
    return { producer_id: producer?.id ?? null };
  }

  async update(id: string, dto: UpdateProducerDto, user: AuthUser, correlationId: string): Promise<ProducerView> {
    const actual = await this.getOrThrow(id);
    assertOwnership(user, actual.userId, 'No puede modificar el perfil de otro productor');

    if (dto.email && dto.email !== actual.email) {
      const duplicado = await this.prisma.producer.findUnique({ where: { email: dto.email } });
      if (duplicado) throw new ConflictException('El email ya esta registrado');
    }

    const actualizado = await this.prisma.$transaction(async (tx) => {
      const producer = await tx.producer.update({
        where: { id },
        data: {
          ...(dto.full_name !== undefined ? { fullName: dto.full_name } : {}),
          ...(dto.email !== undefined ? { email: dto.email } : {}),
          ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          version: { increment: 1 },
        },
      });

      await this.outbox.enqueue(tx, {
        eventType: PRODUCER_EVENTS.updated,
        entityId: producer.id,
        entityVersion: producer.version,
        correlationId,
        payload: {
          producer_id: producer.id,
          user_id: producer.userId,
          full_name: producer.fullName,
          email: producer.email,
          phone: producer.phone,
          status: producer.status,
        },
      });

      return producer;
    });

    return ProducersService.toView(actualizado);
  }

  /** Baja logica: el registro nunca se elimina fisicamente. */
  async disable(id: string, user: AuthUser, correlationId: string): Promise<ProducerView> {
    const actual = await this.getOrThrow(id);
    assertOwnership(user, actual.userId, 'No puede desactivar el perfil de otro productor');
    if (actual.status === 'disabled') return ProducersService.toView(actual);

    const actualizado = await this.prisma.$transaction(async (tx) => {
      const producer = await tx.producer.update({
        where: { id },
        data: { status: 'disabled', version: { increment: 1 } },
      });

      await this.outbox.enqueue(tx, {
        eventType: PRODUCER_EVENTS.disabled,
        entityId: producer.id,
        entityVersion: producer.version,
        correlationId,
        payload: {
          producer_id: producer.id,
          user_id: producer.userId,
          occurred_at: new Date().toISOString(),
        },
      });

      return producer;
    });

    return ProducersService.toView(actualizado);
  }

  /** Reactivar es una operacion administrativa. */
  async enable(id: string, user: AuthUser, correlationId: string): Promise<ProducerView> {
    const actual = await this.getOrThrow(id);
    if (!isAdmin(user)) {
      throw new ForbiddenException('Reactivar un productor es una operacion administrativa');
    }
    if (actual.status === 'active') return ProducersService.toView(actual);

    const actualizado = await this.prisma.$transaction(async (tx) => {
      const producer = await tx.producer.update({
        where: { id },
        data: { status: 'active', version: { increment: 1 } },
      });

      await this.outbox.enqueue(tx, {
        eventType: PRODUCER_EVENTS.updated,
        entityId: producer.id,
        entityVersion: producer.version,
        correlationId,
        payload: { producer_id: producer.id, user_id: producer.userId, status: producer.status },
      });

      return producer;
    });

    return ProducersService.toView(actualizado);
  }

  async getOrThrow(id: string): Promise<Producer> {
    const producer = await this.prisma.producer.findUnique({ where: { id } });
    if (!producer) throw new NotFoundException('Productor inexistente');
    return producer;
  }

  /** Usado por Fincas y Certificaciones antes de crear recursos hijos. */
  async assertActive(id: string): Promise<Producer> {
    const producer = await this.getOrThrow(id);
    if (producer.status !== 'active') {
      throw new ConflictException('El productor no esta activo');
    }
    return producer;
  }

  async validate(id: string): Promise<{ producer_id: string; exists: boolean; active: boolean; user_id: string | null }> {
    const producer = await this.prisma.producer.findUnique({
      where: { id },
      select: { id: true, status: true, userId: true },
    });
    return {
      producer_id: id,
      exists: !!producer,
      active: producer?.status === 'active',
      user_id: producer?.userId ?? null,
    };
  }
}
