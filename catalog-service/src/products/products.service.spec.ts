import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CategoriesService } from '../categories/categories.service';
import { PricesService } from '../prices/prices.service';
import {
  CORRELATION_ID,
  createCacheMock,
  createConfigMock,
  createOutboxMock,
  createPrismaMock,
} from '../test-utils/prisma.mock';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductsService, assertUmbrales } from './products.service';

const PRODUCER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const CATEGORY_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const PRODUCT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

const dtoValido: CreateProductDto = {
  producer_id: PRODUCER_ID,
  name: 'Tomate',
  category_id: CATEGORY_ID,
  unit: 'kg',
  min_order_quantity: 5,
  base_price: 5000,
  low_stock_threshold: 20,
  high_stock_threshold: 100,
};

function productoRow(over: Record<string, unknown> = {}) {
  return {
    id: PRODUCT_ID,
    producerId: PRODUCER_ID,
    name: 'Tomate',
    categoryId: CATEGORY_ID,
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

describe('ProductsService', () => {
  let prisma: any;
  let producerClient: any;
  let outbox: any;
  let cache: any;
  let prices: PricesService;
  let service: ProductsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    outbox = createOutboxMock();
    cache = createCacheMock();
    prices = new PricesService(prisma, outbox, cache, createConfigMock());
    jest.spyOn(prices, 'createInitialVersion').mockResolvedValue({} as any);
    jest.spyOn(prices, 'recalcular').mockResolvedValue({ version: {} as any, cambioPrecio: true });

    producerClient = {
      validateProducer: jest.fn().mockResolvedValue({ producer_id: PRODUCER_ID, exists: true, active: true }),
      validateFarm: jest.fn(),
    };

    service = new ProductsService(
      prisma,
      new CategoriesService(prisma),
      producerClient,
      prices,
      outbox,
      cache,
    );

    prisma.category.findUnique.mockResolvedValue({ id: CATEGORY_ID, name: 'Frutas', active: true });
    prisma.tx.product.create.mockResolvedValue(productoRow());
    prisma.product.findUnique.mockResolvedValue({
      ...productoRow(),
      category: { id: CATEGORY_ID, name: 'Frutas' },
      priceVersions: [],
    });
  });

  describe('crear producto', () => {
    it('valida el productor por REST, no contra producer_db', async () => {
      await service.create(dtoValido, CORRELATION_ID);
      expect(producerClient.validateProducer).toHaveBeenCalledWith(PRODUCER_ID, CORRELATION_ID);
    });

    it('crea el producto y su primera version de precio en la misma transaccion', async () => {
      await service.create(dtoValido, CORRELATION_ID);
      expect(prisma.tx.product.create).toHaveBeenCalled();
      expect(prices.createInitialVersion).toHaveBeenCalledWith(prisma.tx, expect.objectContaining({ id: PRODUCT_ID }));
      expect(outbox.enqueue).toHaveBeenCalled();
    });

    it('rechaza un productor inexistente', async () => {
      producerClient.validateProducer.mockResolvedValue({ exists: false, active: false });
      await expect(service.create(dtoValido, CORRELATION_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rechaza un productor inactivo', async () => {
      producerClient.validateProducer.mockResolvedValue({ exists: true, active: false });
      await expect(service.create(dtoValido, CORRELATION_ID)).rejects.toBeInstanceOf(ConflictException);
    });

    it('rechaza una categoria inexistente', async () => {
      prisma.category.findUnique.mockResolvedValue(null);
      await expect(service.create(dtoValido, CORRELATION_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rechaza high_stock_threshold <= low_stock_threshold', async () => {
      await expect(
        service.create({ ...dtoValido, low_stock_threshold: 100, high_stock_threshold: 100 }, CORRELATION_ID),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('rechaza una unidad distinta de kg', async () => {
      await expect(service.create({ ...dtoValido, unit: 'lb' }, CORRELATION_ID)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
    });
  });

  describe('validacion del DTO', () => {
    it('solo acepta unit = kg', async () => {
      const dto = plainToInstance(CreateProductDto, { ...dtoValido, unit: 'lb' });
      const errores = await validate(dto);
      expect(errores.some((e) => e.property === 'unit')).toBe(true);
    });

    it('rechaza min_order_quantity <= 0', async () => {
      const dto = plainToInstance(CreateProductDto, { ...dtoValido, min_order_quantity: 0 });
      const errores = await validate(dto);
      expect(errores.some((e) => e.property === 'min_order_quantity')).toBe(true);
    });

    it('rechaza base_price <= 0', async () => {
      const dto = plainToInstance(CreateProductDto, { ...dtoValido, base_price: 0 });
      const errores = await validate(dto);
      expect(errores.some((e) => e.property === 'base_price')).toBe(true);
    });

    it('rechaza low_stock_threshold negativo', async () => {
      const dto = plainToInstance(CreateProductDto, { ...dtoValido, low_stock_threshold: -1 });
      const errores = await validate(dto);
      expect(errores.some((e) => e.property === 'low_stock_threshold')).toBe(true);
    });

    it('acepta un DTO valido', async () => {
      expect(await validate(plainToInstance(CreateProductDto, dtoValido))).toHaveLength(0);
    });
  });

  describe('umbrales', () => {
    it('acepta high > low', () => {
      expect(() => assertUmbrales(20, 100)).not.toThrow();
    });
    it('rechaza high == low', () => {
      expect(() => assertUmbrales(20, 20)).toThrow(UnprocessableEntityException);
    });
    it('rechaza high < low', () => {
      expect(() => assertUmbrales(100, 20)).toThrow(UnprocessableEntityException);
    });
  });

  describe('cambio de precio base', () => {
    it('crea una nueva version cuando cambia base_price', async () => {
      prisma.tx.product.update.mockResolvedValue(productoRow({ basePrice: new Prisma.Decimal(7000), version: 2 }));
      prisma.tx.stockState.findUnique.mockResolvedValue({
        productId: PRODUCT_ID,
        availableKg: new Prisma.Decimal(50),
        stockVersion: BigInt(3),
      });

      await service.update(PRODUCT_ID, { base_price: 7000 }, CORRELATION_ID);

      expect(prices.recalcular).toHaveBeenCalledWith(
        prisma.tx,
        expect.objectContaining({ forzarRazon: 'base_change' }),
      );
    });

    it('no crea una version nueva si solo cambia el nombre', async () => {
      prisma.tx.product.update.mockResolvedValue(productoRow({ name: 'Tomate Chonto', version: 2 }));

      await service.update(PRODUCT_ID, { name: 'Tomate Chonto' }, CORRELATION_ID);

      expect(prices.recalcular).not.toHaveBeenCalled();
    });
  });

  describe('baja logica', () => {
    it('desactivar publica product.unavailable y no borra nada', async () => {
      prisma.tx.product.update.mockResolvedValue(productoRow({ active: false, version: 2 }));

      await service.disable(PRODUCT_ID, CORRELATION_ID);

      expect(outbox.enqueue.mock.calls[0][1]).toMatchObject({ eventType: 'product.unavailable' });
      expect(prisma.tx.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ active: false }) }),
      );
    });

    it('activar exige productor activo', async () => {
      prisma.product.findUnique.mockResolvedValue({ ...productoRow({ active: false }), category: null, priceVersions: [] });
      producerClient.validateProducer.mockResolvedValue({ exists: true, active: false });

      await expect(service.enable(PRODUCT_ID, CORRELATION_ID)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  it('getActiveOrThrow rechaza un producto inactivo', async () => {
    prisma.product.findUnique.mockResolvedValue(productoRow({ active: false }));
    await expect(service.getActiveOrThrow(PRODUCT_ID)).rejects.toBeInstanceOf(ConflictException);
  });
});
