import { PriceReason, Prisma } from '@prisma/client';
import { CORRELATION_ID, createCacheMock, createConfigMock, createOutboxMock, createPrismaMock } from '../test-utils/prisma.mock';
import { PricesService } from './prices.service';

const PRODUCT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function productoRow(over: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_ID,
    producerId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
    name: 'Tomate',
    categoryId: 'cccccccc-1111-4111-8111-cccccccccccc',
    unit: 'kg',
    minOrderQuantity: new Prisma.Decimal(5),
    basePrice: new Prisma.Decimal(5000),
    lowStockThreshold: new Prisma.Decimal(20),
    highStockThreshold: new Prisma.Decimal(100),
    active: true,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as any;
}

function versionRow(over: Record<string, unknown> = {}) {
  return {
    id: 'dddddddd-1111-4111-8111-dddddddddddd',
    productId: PRODUCT_ID,
    price: new Prisma.Decimal(5000),
    validFrom: new Date('2026-09-01T10:00:00Z'),
    validTo: null,
    availableKg: new Prisma.Decimal(50),
    stockVersion: BigInt(1),
    reason: PriceReason.initial,
    createdAt: new Date(),
    ...over,
  } as any;
}

describe('PricesService', () => {
  let prisma: any;
  let outbox: any;
  let cache: any;
  let service: PricesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    outbox = createOutboxMock();
    cache = createCacheMock();
    service = new PricesService(prisma, outbox, cache, createConfigMock());
  });

  it('crea la primera version con reason=initial y valid_to null', async () => {
    prisma.tx.priceHistory.create.mockResolvedValue(versionRow());

    await service.createInitialVersion(prisma.tx, productoRow());

    expect(prisma.tx.priceHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reason: PriceReason.initial, validTo: null }),
      }),
    );
  });

  describe('applyVersion', () => {
    it('cierra la version anterior y abre una nueva sin solapamiento', async () => {
      const ahora = new Date('2026-09-15T12:00:00Z');
      prisma.tx.priceHistory.findFirst.mockResolvedValue(versionRow());
      prisma.tx.priceHistory.create.mockResolvedValue(
        versionRow({ id: 'nueva', price: new Prisma.Decimal(5500), validFrom: ahora }),
      );

      const resultado = await service.applyVersion(prisma.tx, {
        product: productoRow(),
        price: new Prisma.Decimal(5500),
        reason: PriceReason.low_stock,
        availableKg: new Prisma.Decimal(10),
        stockVersion: BigInt(2),
        correlationId: CORRELATION_ID,
        at: ahora,
      });

      expect(resultado.cambioPrecio).toBe(true);
      // La anterior se cierra exactamente cuando empieza la nueva.
      expect(prisma.tx.priceHistory.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { validTo: ahora } }),
      );
      expect(prisma.tx.priceHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ validFrom: ahora, validTo: null }) }),
      );
    });

    it('si el precio no cambia solo actualiza disponibilidad y stock_version', async () => {
      prisma.tx.priceHistory.findFirst.mockResolvedValue(versionRow());
      prisma.tx.priceHistory.update.mockResolvedValue(versionRow({ availableKg: new Prisma.Decimal(60) }));

      const resultado = await service.applyVersion(prisma.tx, {
        product: productoRow(),
        price: new Prisma.Decimal(5000),
        reason: PriceReason.normal_stock,
        availableKg: new Prisma.Decimal(60),
        stockVersion: BigInt(3),
        correlationId: CORRELATION_ID,
      });

      expect(resultado.cambioPrecio).toBe(false);
      expect(prisma.tx.priceHistory.create).not.toHaveBeenCalled();
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });

    it('publica el cambio de precio en el outbox', async () => {
      prisma.tx.priceHistory.findFirst.mockResolvedValue(versionRow());
      prisma.tx.priceHistory.create.mockResolvedValue(versionRow({ id: 'nueva', price: new Prisma.Decimal(4500) }));

      await service.applyVersion(prisma.tx, {
        product: productoRow(),
        price: new Prisma.Decimal(4500),
        reason: PriceReason.high_stock,
        availableKg: new Prisma.Decimal(150),
        stockVersion: BigInt(4),
        correlationId: CORRELATION_ID,
      });

      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      expect(outbox.enqueue.mock.calls[0][1]).toMatchObject({
        entityId: PRODUCT_ID,
        correlationId: CORRELATION_ID,
      });
    });
  });

  describe('recalcular', () => {
    it('aplica el precio dinamico con el stock recibido', async () => {
      prisma.tx.priceHistory.findFirst.mockResolvedValue(versionRow());
      prisma.tx.priceHistory.create.mockResolvedValue(versionRow({ price: new Prisma.Decimal(5500) }));

      await service.recalcular(prisma.tx, {
        product: productoRow(),
        availableKg: new Prisma.Decimal(10),
        stockVersion: BigInt(5),
        correlationId: CORRELATION_ID,
      });

      expect(prisma.tx.priceHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ reason: PriceReason.low_stock }),
        }),
      );
      const creado = prisma.tx.priceHistory.create.mock.calls[0][0].data;
      expect(creado.price.toString()).toBe('5500');
    });

    it('permite forzar reason=base_change al cambiar el precio base', async () => {
      prisma.tx.priceHistory.findFirst.mockResolvedValue(versionRow());
      prisma.tx.priceHistory.create.mockResolvedValue(versionRow());

      await service.recalcular(prisma.tx, {
        product: productoRow({ basePrice: new Prisma.Decimal(7000) }),
        availableKg: new Prisma.Decimal(50),
        stockVersion: BigInt(6),
        correlationId: CORRELATION_ID,
        forzarRazon: PriceReason.base_change,
      });

      expect(prisma.tx.priceHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ reason: PriceReason.base_change }) }),
      );
    });
  });

  it('getHistory devuelve las versiones ordenadas por valid_from DESC', async () => {
    prisma.priceHistory.findMany.mockResolvedValue([versionRow()]);

    await service.getHistory(PRODUCT_ID);

    expect(prisma.priceHistory.findMany).toHaveBeenCalledWith({
      where: { productId: PRODUCT_ID },
      orderBy: { validFrom: 'desc' },
    });
  });
});
