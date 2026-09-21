import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PRODUCER_EVENTS } from '../events/event-envelope';
import { CORRELATION_ID, createOutboxMock, createPrismaMock, producerUser } from '../test-utils/prisma.mock';
import { CreateProducerDto } from './dto/create-producer.dto';
import { ProducersService } from './producers.service';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const PRODUCER_ID = '44444444-4444-4444-8444-444444444444';

function producerRow(over: Record<string, unknown> = {}) {
  return {
    id: PRODUCER_ID,
    userId: USER_ID,
    fullName: 'Juan Perez',
    email: 'juan@example.com',
    phone: '3000000000',
    status: 'active',
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('ProducersService', () => {
  let prisma: any;
  let outbox: any;
  let service: ProducersService;

  beforeEach(() => {
    prisma = createPrismaMock();
    outbox = createOutboxMock();
    service = new ProducersService(prisma, outbox);
  });

  describe('crear productor', () => {
    const dto: CreateProducerDto = {
      user_id: USER_ID,
      full_name: 'Juan Perez',
      email: 'juan@example.com',
      phone: '3000000000',
    };

    it('crea un productor valido y encola producer.created en el outbox', async () => {
      prisma.producer.findFirst.mockResolvedValue(null);
      prisma.tx.producer.create.mockResolvedValue(producerRow());

      const resultado = await service.create(dto, producerUser(USER_ID), CORRELATION_ID);

      expect(resultado.id).toBe(PRODUCER_ID);
      expect(resultado.status).toBe('active');
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      expect(outbox.enqueue.mock.calls[0][1]).toMatchObject({
        eventType: PRODUCER_EVENTS.created,
        entityId: PRODUCER_ID,
        correlationId: CORRELATION_ID,
      });
    });

    it('rechaza un user_id que ya tiene perfil de productor', async () => {
      prisma.producer.findFirst.mockResolvedValue({ userId: USER_ID, email: 'otro@example.com' });

      await expect(service.create(dto, producerUser(USER_ID), CORRELATION_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('rechaza un email ya registrado', async () => {
      prisma.producer.findFirst.mockResolvedValue({ userId: 'otro-uuid', email: 'juan@example.com' });

      await expect(service.create(dto, producerUser(USER_ID), CORRELATION_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('impide crear el perfil de otra cuenta de Identity', async () => {
      await expect(
        service.create(dto, producerUser('55555555-5555-4555-8555-555555555555'), CORRELATION_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('validacion del DTO', () => {
    it('rechaza un email invalido', async () => {
      const dto = plainToInstance(CreateProducerDto, {
        user_id: USER_ID,
        full_name: 'Juan',
        email: 'no-es-un-email',
      });
      const errores = await validate(dto);
      expect(errores.some((e) => e.property === 'email')).toBe(true);
    });

    it('normaliza el email a minusculas y sin espacios', async () => {
      const dto = plainToInstance(CreateProducerDto, {
        user_id: USER_ID,
        full_name: '  Juan Perez  ',
        email: '   JUAN@Example.COM  ',
      });
      expect(dto.email).toBe('juan@example.com');
      expect(dto.full_name).toBe('Juan Perez');
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rechaza full_name vacio', async () => {
      const dto = plainToInstance(CreateProducerDto, { user_id: USER_ID, full_name: '   ', email: 'a@b.com' });
      const errores = await validate(dto);
      expect(errores.some((e) => e.property === 'full_name')).toBe(true);
    });
  });

  describe('desactivar', () => {
    it('usa baja logica y publica producer.disabled', async () => {
      prisma.producer.findUnique.mockResolvedValue(producerRow());
      prisma.tx.producer.update.mockResolvedValue(producerRow({ status: 'disabled', version: 2 }));

      const resultado = await service.disable(PRODUCER_ID, producerUser(USER_ID), CORRELATION_ID);

      expect(resultado.status).toBe('disabled');
      expect(outbox.enqueue.mock.calls[0][1]).toMatchObject({
        eventType: PRODUCER_EVENTS.disabled,
        entityVersion: 2,
      });
    });

    it('un productor no puede desactivar a otro', async () => {
      prisma.producer.findUnique.mockResolvedValue(producerRow());

      await expect(
        service.disable(PRODUCER_ID, producerUser('66666666-6666-4666-8666-666666666666'), CORRELATION_ID),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('reactivar', () => {
    it('solo un admin puede reactivar', async () => {
      prisma.producer.findUnique.mockResolvedValue(producerRow({ status: 'disabled' }));

      await expect(service.enable(PRODUCER_ID, producerUser(USER_ID), CORRELATION_ID)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('consultas', () => {
    it('404 cuando el productor no existe', async () => {
      prisma.producer.findUnique.mockResolvedValue(null);
      await expect(service.findOne(PRODUCER_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('assertActive falla si el productor esta deshabilitado', async () => {
      prisma.producer.findUnique.mockResolvedValue(producerRow({ status: 'disabled' }));
      await expect(service.assertActive(PRODUCER_ID)).rejects.toBeInstanceOf(ConflictException);
    });

    it('validate responde existencia y estado sin datos sensibles', async () => {
      prisma.producer.findUnique.mockResolvedValue({ id: PRODUCER_ID, status: 'active' });
      await expect(service.validate(PRODUCER_ID)).resolves.toEqual({
        producer_id: PRODUCER_ID,
        exists: true,
        active: true,
      });
    });

    it('la vista publica no expone user_id', async () => {
      prisma.producer.findUnique.mockResolvedValue(producerRow());
      const vista = await service.findOne(PRODUCER_ID);
      expect(vista).not.toHaveProperty('user_id');
    });
  });
});
