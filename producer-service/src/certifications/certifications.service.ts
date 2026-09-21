import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Certification } from '@prisma/client';
import { AuthUser } from '../common/auth/jwt-auth.guard';
import { assertOwnership } from '../common/auth/ownership';
import { PrismaService } from '../prisma/prisma.service';
import { ProducersService } from '../producers/producers.service';
import { CreateCertificationDto } from './dto/create-certification.dto';
import { QueryCertificationsDto } from './dto/query-certifications.dto';
import { UpdateCertificationDto } from './dto/update-certification.dto';

export interface CertificationView {
  id: string;
  producer_id: string;
  type: string;
  issue_date: string;
  valid_until: string | null;
  status: string;
  /** Vigente = status valid y sin fecha de vencimiento pasada. */
  is_current: boolean;
}

/** Las certificaciones pertenecen al productor; no certifican automaticamente cada finca. */
@Injectable()
export class CertificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly producers: ProducersService,
  ) {}

  static toView(c: Certification, hoy = new Date()): CertificationView {
    return {
      id: c.id,
      producer_id: c.producerId,
      type: c.type,
      issue_date: toDateString(c.issueDate),
      valid_until: c.validUntil ? toDateString(c.validUntil) : null,
      status: c.status,
      is_current: isCurrent(c, hoy),
    };
  }

  async create(producerId: string, dto: CreateCertificationDto, user: AuthUser): Promise<CertificationView> {
    const producer = await this.producers.getOrThrow(producerId);
    assertOwnership(user, producer.userId, 'No puede crear certificaciones de otro productor');

    const issueDate = parseDate(dto.issue_date, 'issue_date');
    const validUntil = dto.valid_until ? parseDate(dto.valid_until, 'valid_until') : null;
    assertRangoFechas(issueDate, validUntil);

    const cert = await this.prisma.certification.create({
      data: { producerId, type: dto.type, issueDate, validUntil, status: 'valid' },
    });
    return CertificationsService.toView(cert);
  }

  async findByProducer(producerId: string, query: QueryCertificationsDto): Promise<CertificationView[]> {
    await this.producers.getOrThrow(producerId);
    const certs = await this.prisma.certification.findMany({
      where: { producerId, ...(query.status ? { status: query.status } : {}) },
      orderBy: { issueDate: 'desc' },
    });
    return certs.map((c) => CertificationsService.toView(c));
  }

  async findOne(id: string): Promise<CertificationView> {
    return CertificationsService.toView(await this.getOrThrow(id));
  }

  async update(id: string, dto: UpdateCertificationDto, user: AuthUser): Promise<CertificationView> {
    const cert = await this.getOrThrow(id);
    const producer = await this.producers.getOrThrow(cert.producerId);
    assertOwnership(user, producer.userId, 'La certificacion no pertenece al usuario autenticado');

    const issueDate = dto.issue_date ? parseDate(dto.issue_date, 'issue_date') : cert.issueDate;
    const validUntil =
      dto.valid_until === undefined
        ? cert.validUntil
        : dto.valid_until === null
          ? null
          : parseDate(dto.valid_until, 'valid_until');
    assertRangoFechas(issueDate, validUntil);

    const actualizada = await this.prisma.certification.update({
      where: { id },
      data: {
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        issueDate,
        validUntil,
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        version: { increment: 1 },
      },
    });
    return CertificationsService.toView(actualizada);
  }

  /** No se elimina el registro: forma parte del historial. */
  async revoke(id: string, user: AuthUser): Promise<CertificationView> {
    const cert = await this.getOrThrow(id);
    const producer = await this.producers.getOrThrow(cert.producerId);
    assertOwnership(user, producer.userId, 'La certificacion no pertenece al usuario autenticado');
    if (cert.status === 'revoked') return CertificationsService.toView(cert);

    const revocada = await this.prisma.certification.update({
      where: { id },
      data: { status: 'revoked', version: { increment: 1 } },
    });
    return CertificationsService.toView(revocada);
  }

  async getOrThrow(id: string): Promise<Certification> {
    const cert = await this.prisma.certification.findUnique({ where: { id } });
    if (!cert) throw new NotFoundException('Certificacion inexistente');
    return cert;
  }
}

export function isCurrent(c: Pick<Certification, 'status' | 'validUntil'>, hoy = new Date()): boolean {
  if (c.status !== 'valid') return false;
  if (!c.validUntil) return true;
  return c.validUntil.getTime() >= startOfDay(hoy).getTime();
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function parseDate(value: string, campo: string): Date {
  const fecha = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(fecha.getTime())) {
    throw new UnprocessableEntityException(`${campo} no es una fecha valida`);
  }
  return fecha;
}

export function assertRangoFechas(issueDate: Date, validUntil: Date | null): void {
  if (validUntil && validUntil.getTime() < issueDate.getTime()) {
    throw new UnprocessableEntityException('valid_until debe ser mayor o igual a issue_date');
  }
}
