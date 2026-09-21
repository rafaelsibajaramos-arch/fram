import { Prisma } from '@prisma/client';
import { CONSUMED_EVENTS, EventEnvelope } from '../events/event-envelope';
import { PricesService } from '../prices/prices.service';
import { createCacheMock, createConfigMock, createOutboxMock, createPrismaMock } from '../test-utils/prisma.mock';
import { InventoryConsumer } from './inventory.consumer';

const PRODUCT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const EVENT_ID = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee';

const rabbitMock = { register: jest.fn(), isConnected: () => true } as any;

function envelope(over: Partial<EventEnvelope> = {}, payload: Record<string, unknown> = {}): EventEnvelope {
  return {
    event_id: EVENT_ID,
    event_type: CONSUMED_EVENTS.inventoryStockChanged,
    source_service: 'inventory-service',
    entity_id: PRODUCT_ID,
    entity_version: 1,
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: '11111111-1111-4111-8111-111111111111',
    payload: { product_id: PRODUCT_ID, stock_version: 15, available_kg: 18, physical_kg: 20, ...payload },
    ...over,
  };
}

function productoRow() {
  return {
    id: PRODUCT_ID,
    producerId: 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
    basePrice: new Prisma.Decimal(5000),
    lowStockThreshold: new Prisma.Decimal(20),
    highStockThreshold: new Prisma.Decimal(100),
    version: 1,
    active: true,
  } as any;
}

describe('InventoryConsumer', () => {
  let prisma: any;
  let prices: PricesService;
  let cache: any;
  let consumer: InventoryConsumer;

  beforeEach(() => {
    prisma = createPrismaMock();
    cache = createCacheMock();
    prices = new PricesService(prisma, createOutboxMock() as any, cache, createConfigMock());
    jest.spyOn(prices, 'recalcular').mockResolvedValue({ version: {} as any, cambioPrecio: true });
    consumer = new InventoryConsumer(prisma, rabbitMock, prices, cache);

    prisma.tx.processedEvent.findUnique.mockResolvedValue(null);
    prisma.tx.product.findUniqueOrThrow.mockResolvedValue(productoRow());
  });

  it('procesa un evento nuevo y recalcula el precio', async () => {
    prisma.tx.stockState.findUnique.mockResolvedValue({ productId: PRODUCT_ID, stockVersion: BigInt(14) });

    await consumer.handle(envelope());

    expect(prisma.tx.stockState.upsert).toHaveBeenCalled();
    expect(prices.recalcular).toHaveBeenCalledWith(
      prisma.tx,
      expect.objectContaining({ stockVersion: BigInt(15) }),
    );
    expect(cache.invalidateProduct).toHaveBeenCalledWith(PRODUCT_ID);
  });

  it('ignora un evento con stock_version anterior a la procesada', async () => {
    prisma.tx.stockState.findUnique.mockResolvedValue({ productId: PRODUCT_ID, stockVersion: BigInt(20) });

    await consumer.handle(envelope());

    expect(prisma.tx.stockState.upsert).not.toHaveBeenCalled();
    expect(prices.recalcular).not.toHaveBeenCalled();
  });

  it('ignora un evento con la misma stock_version (no retrocede el catalogo)', async () => {
    prisma.tx.stockState.findUnique.mockResolvedValue({ productId: PRODUCT_ID, stockVersion: BigInt(15) });

    await consumer.handle(envelope());

    expect(prices.recalcular).not.toHaveBeenCalled();
  });

  it('es idempotente ante un event_id duplicado', async () => {
    prisma.tx.processedEvent.findUnique.mockResolvedValue({ eventId: EVENT_ID });

    await consumer.handle(envelope());

    expect(prisma.tx.stockState.upsert).not.toHaveBeenCalled();
    expect(prices.recalcular).not.toHaveBeenCalled();
  });

  it('acepta el primer evento cuando no hay estado previo', async () => {
    prisma.tx.stockState.findUnique.mockResolvedValue(null);

    await consumer.handle(envelope());

    expect(prices.recalcular).toHaveBeenCalled();
  });

  it('descarta el evento si no trae product_id', async () => {
    await consumer.handle(envelope({}, { product_id: undefined }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('no falla si el producto ya no existe en el catalogo', async () => {
    prisma.tx.$queryRaw.mockResolvedValue([]);

    await expect(consumer.handle(envelope())).resolves.toBeUndefined();
    expect(prices.recalcular).not.toHaveBeenCalled();
  });
});
