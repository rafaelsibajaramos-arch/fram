import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CORRELATION_ID, createOutboxMock, createPrismaMock } from '../test-utils/prisma.mock';
import { HarvestBatchesService } from './harvest-batches.service';

const PRODUCER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const OTRO_PRODUCER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const PRODUCT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const FARM_ID = 'ffffffff-1111-4111-8111-ffffffffffff';
const BATCH_ID = '99999999-1111-4111-8111-999999999999';

const dtoValido = {
  product_id: PRODUCT_ID,
  farm_id: FARM_ID,
  harvest_date: '2026-09-15',
  quantity_kg: 100,
  expiry_estimate: '2026-09-25',
};

function productoRow(over: Record<string, unknown> = {}) {
  return { id: PRODUCT_ID, producerId: PRODUCER_ID, active: true, version: 1, ...over } as any;
}

function loteRow(over: Record<string, unknown> = {}) {
  return {
    batchId: BATCH_ID,
    productId: PRODUCT_ID,
    farmId: FARM_ID,
    producerId: PRODUCER_ID,
    harvestDate: new Date('2026-09-15T00:00:00Z'),
    quantityKg: new Prisma.Decimal(100),
    expiryEstimate: new Date('2026-09-25T00:00:00Z'),
    status: 'registered',
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as any;
}

describe('HarvestBatchesService', () => {
  let prisma: any;
  let products: any;
  let producerClient: any;
  let outbox: any;
  let service: HarvestBatchesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    outbox = createOutboxMock();
    products = {
      getActiveOrThrow: jest.fn().mockResolvedValue(productoRow()),
      getOrThrow: jest.fn().mockResolvedValue(productoRow()),
    };
    producerClient = {
      validateProducer: jest.fn().mockResolvedValue({ exists: true, active: true }),
      validateFarm: jest.fn().mockResolvedValue({
        farm_id: FARM_ID,
        exists: true,
        active: true,
        producer_id: PRODUCER_ID,
        producer_active: true,
      }),
    };
    service = new HarvestBatchesService(prisma, products, producerClient, outbox);
    prisma.harvestBatch.create.mockResolvedValue(loteRow());
  });

  describe('registrar lote', () => {
    it('registra un lote valido', async () => {
      const resultado = await service.create(dtoValido, CORRELATION_ID);
      expect(resultado).toMatchObject({
        batch_id: BATCH_ID,
        producer_id: PRODUCER_ID,
        quantity_kg: 100,
        status: 'registered',
      });
    });

    it('rechaza un producto inactivo', async () => {
      products.getActiveOrThrow.mockRejectedValue(new ConflictException('El producto no esta activo'));
      await expect(service.create(dtoValido, CORRELATION_ID)).rejects.toBeInstanceOf(ConflictException);
    });

    it('rechaza si el productor del producto no esta activo', async () => {
      producerClient.validateProducer.mockResolvedValue({ exists: true, active: false });
      await expect(service.create(dtoValido, CORRELATION_ID)).rejects.toBeInstanceOf(ConflictException);
    });

    it('rechaza una finca inexistente', async () => {
      producerClient.validateFarm.mockResolvedValue({ exists: false, active: false, producer_id: null });
      await expect(service.create(dtoValido, CORRELATION_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rechaza una finca inactiva', async () => {
      producerClient.validateFarm.mockResolvedValue({ exists: true, active: false, producer_id: PRODUCER_ID });
      await expect(service.create(dtoValido, CORRELATION_ID)).rejects.toBeInstanceOf(ConflictException);
    });

    it('rechaza una finca que no pertenece al productor del producto', async () => {
      producerClient.validateFarm.mockResolvedValue({ exists: true, active: true, producer_id: OTRO_PRODUCER });
      await expect(service.create(dtoValido, CORRELATION_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.harvestBatch.create).not.toHaveBeenCalled();
    });

    it('rechaza expiry_estimate anterior a harvest_date', async () => {
      await expect(
        service.create({ ...dtoValido, expiry_estimate: '2026-09-14' }, CORRELATION_ID),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('acepta expiry_estimate igual a harvest_date', async () => {
      await expect(
        service.create({ ...dtoValido, expiry_estimate: '2026-09-15' }, CORRELATION_ID),
      ).resolves.toBeDefined();
    });
  });

  describe('publicar lote', () => {
    beforeEach(() => {
      prisma.harvestBatch.findUnique.mockResolvedValue(loteRow());
      prisma.tx.harvestBatch.update.mockResolvedValue(loteRow({ status: 'published', version: 2 }));
    });

    it('cambia el estado y encola harvest.registered', async () => {
      const resultado = await service.publish(BATCH_ID, CORRELATION_ID);

      expect(resultado.status).toBe('published');
      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      expect(outbox.enqueue.mock.calls[0][1]).toMatchObject({
        eventType: 'harvest.registered',
        entityId: BATCH_ID,
      });
      expect(outbox.enqueue.mock.calls[0][1].payload).toMatchObject({
        batch_id: BATCH_ID,
        product_id: PRODUCT_ID,
        producer_id: PRODUCER_ID,
        farm_id: FARM_ID,
        quantity_kg: 100,
        harvest_date: '2026-09-15',
        expiry_estimate: '2026-09-25',
      });
    });

    it('si la finca no se puede validar, el lote no se publica', async () => {
      producerClient.validateFarm.mockResolvedValue({ exists: true, active: false, producer_id: PRODUCER_ID });

      await expect(service.publish(BATCH_ID, CORRELATION_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('no republica un lote ya publicado', async () => {
      prisma.harvestBatch.findUnique.mockResolvedValue(loteRow({ status: 'published' }));

      await service.publish(BATCH_ID, CORRELATION_ID);

      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('no publica un lote cerrado', async () => {
      prisma.harvestBatch.findUnique.mockResolvedValue(loteRow({ status: 'closed' }));
      await expect(service.publish(BATCH_ID, CORRELATION_ID)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('cerrar lote', () => {
    it('cambia el estado sin borrar el lote', async () => {
      prisma.harvestBatch.findUnique.mockResolvedValue(loteRow({ status: 'published' }));
      prisma.harvestBatch.update.mockResolvedValue(loteRow({ status: 'closed', version: 2 }));

      const resultado = await service.close(BATCH_ID);

      expect(resultado.status).toBe('closed');
      expect(prisma.harvestBatch.update).toHaveBeenCalled();
    });
  });
});
