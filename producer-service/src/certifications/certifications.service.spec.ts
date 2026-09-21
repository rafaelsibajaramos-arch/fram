import { UnprocessableEntityException } from '@nestjs/common';
import { ProducersService } from '../producers/producers.service';
import { createOutboxMock, createPrismaMock, producerUser } from '../test-utils/prisma.mock';
import { CertificationsService, isCurrent } from './certifications.service';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const PRODUCER_ID = '44444444-4444-4444-8444-444444444444';
const CERT_ID = '99999999-9999-4999-8999-999999999999';

function producerRow(over: Record<string, unknown> = {}) {
  return {
    id: PRODUCER_ID,
    userId: USER_ID,
    fullName: 'Juan Perez',
    email: 'juan@example.com',
    phone: null,
    status: 'active',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function certRow(over: Record<string, unknown> = {}) {
  return {
    id: CERT_ID,
    producerId: PRODUCER_ID,
    type: 'Organica',
    issueDate: new Date('2026-01-10T00:00:00Z'),
    validUntil: new Date('2027-01-10T00:00:00Z'),
    status: 'valid',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe('CertificationsService', () => {
  let prisma: any;
  let service: CertificationsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new CertificationsService(prisma, new ProducersService(prisma, createOutboxMock() as any));
    prisma.producer.findUnique.mockResolvedValue(producerRow());
  });

  it('crea una certificacion valida', async () => {
    prisma.certification.create.mockResolvedValue(certRow());

    const resultado = await service.create(
      PRODUCER_ID,
      { type: 'Organica', issue_date: '2026-01-10', valid_until: '2027-01-10' },
      producerUser(USER_ID),
    );

    expect(resultado.status).toBe('valid');
    expect(resultado.issue_date).toBe('2026-01-10');
    expect(resultado.valid_until).toBe('2027-01-10');
  });

  it('rechaza valid_until anterior a issue_date', async () => {
    await expect(
      service.create(
        PRODUCER_ID,
        { type: 'Organica', issue_date: '2026-01-10', valid_until: '2025-12-31' },
        producerUser(USER_ID),
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.certification.create).not.toHaveBeenCalled();
  });

  it('acepta valid_until igual a issue_date', async () => {
    prisma.certification.create.mockResolvedValue(
      certRow({ validUntil: new Date('2026-01-10T00:00:00Z') }),
    );
    await expect(
      service.create(
        PRODUCER_ID,
        { type: 'Organica', issue_date: '2026-01-10', valid_until: '2026-01-10' },
        producerUser(USER_ID),
      ),
    ).resolves.toMatchObject({ valid_until: '2026-01-10' });
  });

  it('acepta certificacion sin caducidad', async () => {
    prisma.certification.create.mockResolvedValue(certRow({ validUntil: null }));
    const resultado = await service.create(
      PRODUCER_ID,
      { type: 'Organica', issue_date: '2026-01-10' },
      producerUser(USER_ID),
    );
    expect(resultado.valid_until).toBeNull();
    expect(resultado.is_current).toBe(true);
  });

  it('revocar cambia el estado sin borrar el registro', async () => {
    prisma.certification.findUnique.mockResolvedValue(certRow());
    prisma.certification.update.mockResolvedValue(certRow({ status: 'revoked', version: 2 }));

    const resultado = await service.revoke(CERT_ID, producerUser(USER_ID));

    expect(resultado.status).toBe('revoked');
    expect(resultado.is_current).toBe(false);
    expect(prisma.certification.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'revoked' }) }),
    );
  });

  describe('vigencia', () => {
    const hoy = new Date('2026-06-01T00:00:00Z');

    it('es vigente si status=valid y no ha vencido', () => {
      expect(isCurrent({ status: 'valid', validUntil: new Date('2026-06-02T00:00:00Z') } as any, hoy)).toBe(true);
    });

    it('no es vigente si ya vencio', () => {
      expect(isCurrent({ status: 'valid', validUntil: new Date('2026-05-31T00:00:00Z') } as any, hoy)).toBe(false);
    });

    it('no es vigente si fue revocada aunque la fecha sirva', () => {
      expect(isCurrent({ status: 'revoked', validUntil: new Date('2027-01-01T00:00:00Z') } as any, hoy)).toBe(false);
    });
  });
});
