import { AnalyticsService } from './analytics.service';
import { EventEnvelope } from './event-envelope';

const orderId = 'c9ac31a8-326d-4fc0-9ef8-3e87f4358c39';
const buyerId = '868c57d1-31be-485e-a15b-634c500aa564';
const productId = '32bbe7ad-6a53-4dd6-944d-e1720bbfb52c';
const itemId = 'be42b2ec-d083-45ce-a264-2a92564ec650';
const paymentId = '3e84633e-8122-40ec-8e8c-225bfa311f29';
const eventId = '2c4547ef-6bc4-4e1b-8b6e-1eead60bad63';
const correlationId = '3243494e-46a8-4700-a469-b8c92e0554b4';

describe('AnalyticsService', () => {
  const periodUpsert = jest.fn(); const eventFind = jest.fn(); const eventCreate = jest.fn();
  const orderUpsert = jest.fn(); const fulfillmentFind = jest.fn(); const lineUpsert = jest.fn();
  const outboxCreate = jest.fn(); const db: any = {};
  let service: AnalyticsService;

  beforeEach(() => {
    jest.clearAllMocks();
    periodUpsert.mockResolvedValue({ id: 'b135cdfd-f924-4655-a07b-e9363b6f9571' });
    eventFind.mockResolvedValue(null); eventCreate.mockResolvedValue({}); orderUpsert.mockResolvedValue({});
    fulfillmentFind.mockResolvedValue(null); lineUpsert.mockResolvedValue({}); outboxCreate.mockResolvedValue({});
    Object.assign(db, {
      $transaction: jest.fn(async (fn: (tx: any) => unknown) => fn({
        analyticsPeriod: { upsert: periodUpsert },
        processedEvent: { findUnique: eventFind, create: eventCreate },
        orderFact: { upsert: orderUpsert }, fulfillmentLineFact: { findUnique: fulfillmentFind },
        orderLineFact: { upsert: lineUpsert }, outboxEvent: { create: outboxCreate },
      })),
    });
    service = new AnalyticsService(db);
  });

  it('projects versioned order facts and a UTC period in the same transaction', async () => {
    const result = await service.consume(envelope('order.confirmed', {
      orderId, buyerId, paymentId,
      items: [{ id: itemId, productId, producerId: buyerId, productName: 'Tomate', quantity: '4.000', unitPrice: '2500.00' }],
    }));
    expect(result).toEqual({ processed: true, event_type: 'order.confirmed' });
    expect(periodUpsert).toHaveBeenCalledWith(expect.objectContaining({ where: { startDate: new Date('2026-10-17T00:00:00.000Z') } }));
    expect(eventCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventId, eventType: 'order.confirmed', periodId: 'b135cdfd-f924-4655-a07b-e9363b6f9571' }) });
    expect(lineUpsert).toHaveBeenCalledTimes(1);
    expect(lineUpsert.mock.calls[0][0].where).toEqual({ orderItemId: itemId });
    expect(lineUpsert.mock.calls[0][0].create.productId).toBe(productId);
    expect(lineUpsert.mock.calls[0][0].create.quantityKg.toString()).toBe('4');
    expect(lineUpsert.mock.calls[0][0].create.unitPrice.toString()).toBe('2500');
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it('does not apply a redelivered source event twice', async () => {
    eventFind.mockResolvedValue({ eventId });
    await service.consume(envelope('order.confirmed', { orderId, buyerId, items: [] }));
    expect(orderUpsert).not.toHaveBeenCalled(); expect(eventCreate).not.toHaveBeenCalled(); expect(outboxCreate).not.toHaveBeenCalled();
  });

  it('requires an explicit confirmation before rebuilding projections', async () => {
    await expect(service.rebuildProjections('')).rejects.toThrow('REBUILD_ANALYTICS_PROJECTIONS');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rebuilds derived facts from the archived event log in dependency order', async () => {
    const closedAt = new Date('2026-10-17T19:20:00.000Z');
    const archivedEvents = [
      { eventId: '4126d369-d5d1-4f55-ae9b-7c5c502e34a1', eventType: 'order.fulfillment_closed', sourceService: 'logistics-service', entityId: orderId, entityVersion: 1, schemaVersion: 1, occurredAt: closedAt, correlationId, payload: { order_id: orderId, items: [{ order_item_id: itemId, accepted_quantity_kg: '3.000', accepted_amount: '75.00' }] } },
      { eventId, eventType: 'order.confirmed', sourceService: 'order-service', entityId: orderId, entityVersion: 1, schemaVersion: 1, occurredAt: closedAt, correlationId, payload: { orderId, buyerId, paymentId, items: [{ id: itemId, productId, producerId: buyerId, productName: 'Tomate', quantity: '4.000', unitPrice: '25.00' }] } },
    ];
    const tx: any = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      processedEvent: { findMany: jest.fn().mockResolvedValue(archivedEvents) },
      orderFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), upsert: jest.fn().mockResolvedValue({}) },
      orderLineFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), upsert: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      fulfillmentLineFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({}) },
      paymentFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) }, refundFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      wasteFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) }, harvestFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      deliveryStatusFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) }, deliveryFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      coldChainFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) }, ratingFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      stockFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) }, movementFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
      productFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) }, producerFact: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    db.$transaction.mockImplementationOnce(async (fn: (transaction: any) => unknown) => fn(tx));

    await expect(service.rebuildProjections('REBUILD_ANALYTICS_PROJECTIONS')).resolves.toMatchObject({ events_replayed: 2 });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.processedEvent.findMany).toHaveBeenCalledTimes(1);
    expect(tx.orderFact.upsert).toHaveBeenCalledTimes(1);
    expect(tx.orderLineFact.upsert).toHaveBeenCalledTimes(1);
    expect(tx.fulfillmentLineFact.upsert).toHaveBeenCalledTimes(1);
    expect(tx.orderLineFact.updateMany).toHaveBeenCalledWith({ where: { orderItemId: itemId }, data: { acceptedQuantity: expect.anything(), acceptedAmount: expect.anything() } });
  });

  it('reports captured sales and refunds separately, using accepted line amounts', async () => {
    db.paymentFact = { findMany: jest.fn().mockResolvedValue([{ orderId, amount: '90.00' }]) };
    db.orderLineFact = { findMany: jest.fn().mockResolvedValue([{ orderId, productId, producerId: buyerId, productName: 'Tomate', acceptedQuantity: '3.000', acceptedAmount: '75.00' }]) };
    db.producerFact = { findMany: jest.fn().mockResolvedValue([]) };
    db.refundFact = { findMany: jest.fn().mockResolvedValue([{ amount: '10.00' }]) };
    const result: any = await service.sales({ start: '2026-10-01', end: '2026-10-18', timezone: 'America/Bogota' });
    expect(result.captured_cop).toBe(90); expect(result.refunded_cop).toBe(10); expect(result.unallocated_cop).toBe(15);
    expect(result.by_product[0]).toMatchObject({ product_id: productId, kg: 3, revenue_cop: 75 });
    expect(result.period.timezone).toBe('America/Bogota');
    expect(result.period.start_utc).toBe('2026-10-01T05:00:00.000Z');
    expect(result.period.end_utc_exclusive).toBe('2026-10-18T05:00:00.000Z');
  });

  it('never attributes more revenue to products than the amount captured for their order', async () => {
    db.paymentFact = { findMany: jest.fn().mockResolvedValue([{ orderId, amount: '50.00' }]) };
    db.orderLineFact = { findMany: jest.fn().mockResolvedValue([{ orderId, productId, producerId: buyerId, productName: 'Tomate', acceptedQuantity: '3.000', acceptedAmount: '75.00' }]) };
    db.producerFact = { findMany: jest.fn().mockResolvedValue([]) };
    db.refundFact = { findMany: jest.fn().mockResolvedValue([]) };
    const result: any = await service.sales({ start: '2026-10-01', end: '2026-10-02', timezone: 'UTC' });
    expect(result.captured_cop).toBe(50);
    expect(result.by_product[0].revenue_cop).toBe(50);
    expect(result.unallocated_cop).toBe(0);
    expect(result.coverage).toBe('complete');
  });

  it('rejects an unknown IANA timezone instead of returning a misleading report', async () => {
    db.paymentFact = { findMany: jest.fn() }; db.refundFact = { findMany: jest.fn() };
    await expect(service.sales({ start: '2026-10-01', end: '2026-10-02', timezone: 'Not/AZone' })).rejects.toThrow('Zona horaria IANA no reconocida');
  });

  it('uses timezone-local midnights across daylight-saving transitions', async () => {
    db.paymentFact = { findMany: jest.fn().mockResolvedValue([]) }; db.refundFact = { findMany: jest.fn().mockResolvedValue([]) };
    const result: any = await service.sales({ start: '2026-03-08', end: '2026-03-09', timezone: 'America/New_York' });
    expect(result.period.start_utc).toBe('2026-03-08T05:00:00.000Z');
    expect(result.period.end_utc_exclusive).toBe('2026-03-09T04:00:00.000Z');
  });

  it('calculates waste cohort against the whole batch history, including harvests before the report range', async () => {
    const batchId = 'fd43bc8c-edbf-4fd1-bfb6-19286d02d3a2';
    db.wasteFact = { findMany: jest.fn()
      .mockResolvedValueOnce([{ productId, quantityKg: '2', reason: 'damage', batchId }])
      .mockResolvedValueOnce([{ batchId, quantityKg: '5' }, { batchId, quantityKg: '2' }]) };
    db.harvestFact = { findMany: jest.fn().mockResolvedValue([{ batchId, productId, quantityKg: '100', harvestedAt: new Date('2026-09-01T12:00:00Z') }]) };
    db.productFact = { findMany: jest.fn().mockResolvedValue([{ productId, name: 'Tomate' }]) };
    const result: any = await service.waste({ start: '2026-10-01', end: '2026-10-02', timezone: 'UTC' });
    expect(result.wasted_kg).toBe(2);
    expect(result.harvest_cohorts[0]).toMatchObject({ harvested_kg: 100, wasted_kg: 7, waste_percent: 7 });
    expect(result.coverage).toBe('complete');
  });
});

function envelope(eventType: string, payload: Record<string, unknown>): EventEnvelope {
  return { event_id: eventId, event_type: eventType, source_service: 'order-service', entity_id: orderId, entity_version: 1, schema_version: 1, occurred_at: '2026-10-17T19:20:00.000Z', correlation_id: correlationId, payload };
}
