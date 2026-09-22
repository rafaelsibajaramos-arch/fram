import { ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
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
  file: { name: string; mime_type: string; size: number; url: string } | null;
  verification: { status: string; notes: string | null; verified_by: string | null; verified_at: string | null };
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
      file: c.storageKey && c.fileName && c.mimeType && c.fileSize !== null
        ? { name: c.fileName, mime_type: c.mimeType, size: c.fileSize, url: `/certifications/${c.id}/file` }
        : null,
      verification: {
        status: c.verificationStatus,
        notes: c.verificationNotes,
        verified_by: c.verifiedBy,
        verified_at: c.verifiedAt?.toISOString() ?? null,
      },
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

  async attachFile(id: string, file: Express.Multer.File, user: AuthUser): Promise<CertificationView> {
    const cert = await this.getOrThrow(id);
    const producer = await this.producers.getOrThrow(cert.producerId);
    assertOwnership(user, producer.userId, 'La certificacion no pertenece al usuario autenticado');
    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) throw new UnprocessableEntityException('Solo se permiten PDF, JPG, PNG o WEBP');
    if (file.size > 10 * 1024 * 1024) throw new UnprocessableEntityException('El archivo no puede superar 10 MB');
    const key = `${cert.id}-${randomUUID()}-${sanitize(file.originalname)}`;
    const dir = join(process.cwd(), process.env.CERT_UPLOAD_DIR ?? 'uploads/certifications');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, key), file.buffer);
    const updated = await this.prisma.certification.update({ where: { id }, data: { fileName: file.originalname, mimeType: file.mimetype, fileSize: file.size, storageKey: key, verificationStatus: 'pending', verificationNotes: null, verifiedBy: null, verifiedAt: null, version: { increment: 1 } } });
    return CertificationsService.toView(updated);
  }

  async listPending(user: AuthUser): Promise<CertificationView[]> {
    this.assertAdmin(user);
    const certs = await this.prisma.certification.findMany({ where: { verificationStatus: 'pending', storageKey: { not: null } }, orderBy: { createdAt: 'asc' } });
    return certs.map((c) => CertificationsService.toView(c));
  }

  async verify(id: string, status: 'approved' | 'rejected', notes: string | undefined, user: AuthUser): Promise<CertificationView> {
    this.assertAdmin(user);
    const cert = await this.getOrThrow(id);
    const updated = await this.prisma.certification.update({ where: { id }, data: { verificationStatus: status, verificationNotes: notes?.trim() || null, verifiedBy: user.sub, verifiedAt: new Date(), version: { increment: 1 } } });
    return CertificationsService.toView(updated);
  }

  private assertAdmin(user: AuthUser): void {
    if (!user.roles.some((role) => ['admin', 'administrator', 'certification_admin'].includes(role.toLowerCase()))) throw new ForbiddenException('Se requiere rol administrador');
  }

  async file(id: string, user: AuthUser): Promise<{ path: string; mime: string; name: string }> {
    const cert = await this.getOrThrow(id);
    const producer = await this.producers.getOrThrow(cert.producerId);
    assertOwnership(user, producer.userId, 'No puede consultar el documento de otro productor');
    if (!cert.storageKey || !cert.mimeType || !cert.fileName) throw new NotFoundException('La certificacion no tiene archivo');
    return { path: join(process.cwd(), process.env.CERT_UPLOAD_DIR ?? 'uploads/certifications', cert.storageKey), mime: cert.mimeType, name: cert.fileName };
  }

  async findByProducer(producerId: string, query: QueryCertificationsDto, user: AuthUser): Promise<CertificationView[]> {
    const producer = await this.producers.getOrThrow(producerId);
    assertOwnership(user, producer.userId, 'No puede consultar las certificaciones de otro productor');
    const certs = await this.prisma.certification.findMany({
      where: { producerId, ...(query.status ? { status: query.status } : {}) },
      orderBy: { issueDate: 'desc' },
    });
    return certs.map((c) => CertificationsService.toView(c));
  }

  async findOne(id: string, user: AuthUser): Promise<CertificationView> {
    const cert = await this.getOrThrow(id);
    const producer = await this.producers.getOrThrow(cert.producerId);
    assertOwnership(user, producer.userId, 'No puede consultar la certificacion de otro productor');
    return CertificationsService.toView(cert);
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

function sanitize(name: string): string {
  return name.normalize('NFKD').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
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
