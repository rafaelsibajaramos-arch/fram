import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InventoryService } from './inventory.service';

const buyerId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const reservationId = '33333333-3333-4333-8333-333333333333';
const idempotencyKey = 'checkout:stable-operation-1';

function inventoryItem(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    batchId: '55555555-5555-4555-8555-555555555555',
    productId,
    expiryEstimate: new Date('2026-12-31T00:00:00.000Z'),
    status: 'available',
    physicalKg: new Prisma.Decimal('20'),
    availableKg: new Prisma.Decimal('20'),
    stockVersion: 1n,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function reservation(item = inventoryItem(), overrides: Record<string, unknown> = {}) {
  return {
    id: reservationId,
    itemId: item.id,
    buyerId,
    idempotencyKey,
    quantityKg: new Prisma.Decimal('4'),
    status: 'active',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    item,
    ...overrides,
  };
}

describe('InventoryService reservations', () => {
  let service: InventoryService;
  let db: any;
  let tx: any;

  beforeEach(() => {
    const item = inventoryItem();
    const reserved = reservation(item);
    tx = {
      inventoryItem: {
        upsert: jest.fn().mockResolvedValue(item),
        findFirst: jest.fn().mockResolvedValue(item),
        findUniqueOrThrow: jest.fn().mockResolvedValue(item),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(item),
      },
      reservation: {
        findMany: jest.fn().mockResolvedValue([reserved]),
        findUnique: jest.fn().mockResolvedValue(reserved),
        findUniqueOrThrow: jest.fn().mockResolvedValue(reserved),
        create: jest.fn().mockResolvedValue(reserved),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryMovement: { create: jest.fn().mockResolvedValue({ id: '66666666-6666-4666-8666-666666666666', createdAt: new Date() }) },
      outboxEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    db = {
      reservation: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      inventoryItem: { findMany: jest.fn().mockResolvedValue([]) },
      outboxEvent: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    service = new InventoryService(db, {} as any);
  });

  it('selecciona el lote elegible más próximo a vencer (FEFO)', async () => {
    await service.reserve({ product_id: productId, quantity_kg: 4, idempotency_key: idempotencyKey }, buyerId);
    expect(tx.inventoryItem.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ productId, status: 'available', availableKg: { gte: expect.any(Prisma.Decimal) } }),
      orderBy: [{ expiryEstimate: 'asc' }, { id: 'asc' }],
    }));
  });

  it('reproduce la misma reserva en un reintento sin descontar stock otra vez', async () => {
    const existing = reservation();
    db.reservation.findUnique.mockResolvedValue(existing);
    const result = await service.reserve({ product_id: productId, quantity_kg: 4, idempotency_key: idempotencyKey }, buyerId);
    expect(result).toMatchObject({ replayed: true, reservation: { id: reservationId, quantity_kg: 4 } });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('rechaza reutilizar la misma clave para otra cantidad', async () => {
    db.reservation.findUnique.mockResolvedValue(reservation());
    await expect(service.reserve({ product_id: productId, quantity_kg: 5, idempotency_key: idempotencyKey }, buyerId)).rejects.toBeInstanceOf(ConflictException);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('resuelve una carrera de clave única devolviendo la reserva ganadora', async () => {
    const winner = reservation();
    db.reservation.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    tx.reservation.create.mockRejectedValueOnce({ code: 'P2002' });
    const result = await service.reserve({ product_id: productId, quantity_kg: 4, idempotency_key: idempotencyKey }, buyerId);
    expect(result).toMatchObject({ replayed: true, reservation: { id: reservationId } });
  });

  it('reclama el estado active antes de devolver stock al liberar', async () => {
    const current = reservation(undefined, { status: 'active' });
    tx.reservation.findUnique.mockResolvedValue(current);
    await service.release(reservationId, buyerId);
    expect(tx.reservation.updateMany).toHaveBeenCalledWith({ where: { id: reservationId, status: 'active' }, data: { status: 'released' } });
    expect(tx.inventoryItem.update).toHaveBeenCalledTimes(1);
  });

  it('conserva el snapshot de finca recibido con la cosecha', async () => {
    const event = {
      event_id: '77777777-7777-4777-8777-777777777777', event_type: 'harvest.registered', source_service: 'catalog-service',
      entity_id: '55555555-5555-4555-8555-555555555555', entity_version: 2, schema_version: 1,
      occurred_at: new Date().toISOString(), correlation_id: '88888888-8888-4888-8888-888888888888',
      payload: { batch_id: '55555555-5555-4555-8555-555555555555', product_id: productId, farm_id: '99999999-9999-4999-8999-999999999999', pickup_address: 'Finca La Esperanza', pickup_latitude: 8.7, pickup_longitude: -75.8, quantity_kg: 10, expiry_estimate: '2026-12-31' },
    };
    tx.processedEvent = { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) };
    await service.receiveHarvest(event as any);
    expect(tx.inventoryItem.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ farmId: event.payload.farm_id, pickupAddress: 'Finca La Esperanza', pickupLatitude: new Prisma.Decimal(8.7), pickupLongitude: new Prisma.Decimal(-75.8) }),
    }));
  });

  it('no vuelve a consumir una reserva ya consumida', async () => {
    tx.reservation.findUnique.mockResolvedValue(reservation(undefined, { status: 'consumed' }));
    await service.consume(reservationId, buyerId);
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
    expect(tx.inventoryItem.update).not.toHaveBeenCalled();
  });

  it('consume en una sola transacción y devuelve replay al repetir el lote completo', async () => {
    const active = reservation();
    tx.reservation.findMany.mockResolvedValue([active]);
    tx.reservation.findUniqueOrThrow.mockResolvedValue({ ...active, status: 'consumed' });
    await expect(service.consumeBatch([reservationId], buyerId)).resolves.toMatchObject({ consumed: true, replayed: false });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.reservation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: reservationId, status: 'active' }) }));
    tx.reservation.findMany.mockResolvedValue([{ ...active, status: 'consumed' }]);
    await expect(service.consumeBatch([reservationId], buyerId)).resolves.toMatchObject({ consumed: true, replayed: true });
  });

  it('rechaza un lote con reserva expirada sin consumir ninguna línea', async () => {
    tx.reservation.findMany.mockResolvedValue([reservation(undefined, { status: 'expired' })]);
    await expect(service.consumeBatch([reservationId], buyerId)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
    expect(tx.inventoryItem.update).not.toHaveBeenCalled();
  });

  it('reserva cada línea del pedido con clave idempotente y publica el resultado de la saga', async () => {
    const orderId = '77777777-7777-4777-8777-777777777777';
    const orderItemId = '88888888-8888-4888-8888-888888888888';
    const eventId = '99999999-9999-4999-8999-999999999999';
    db.processedEvent = { findUnique: jest.fn().mockResolvedValue(null) };
    tx.processedEvent = { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) };
    const reserved = { reservation: reservation(), stock: { batch_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', farm_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', pickup_address: 'Finca La Esperanza', pickup_latitude: 8.7, pickup_longitude: -75.8 } };
    jest.spyOn(service, 'reserve').mockResolvedValue(reserved as any);
    const event: any = {
      event_id: eventId, event_type: 'order.created', source_service: 'order-service', entity_id: orderId,
      entity_version: 1, schema_version: 1, correlation_id: eventId, occurred_at: new Date().toISOString(),
      payload: { checkout_mode: 'async_saga', order_id: orderId, buyer_id: buyerId, total_amount: '480', currency: 'COP', items: [{ order_item_id: orderItemId, product_id: productId, quantity_kg: 4, subtotal: '480' }] },
    };

    await expect(service.reserveCheckoutOrder(event)).resolves.toMatchObject({ reserved: true });

    expect(service.reserve).toHaveBeenCalledWith(expect.objectContaining({
      idempotency_key: `saga:${orderId}:${orderItemId}`, order_id: orderId, order_item_id: orderItemId,
    }), buyerId, eventId);
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'inventory.order_reserved', payload: expect.objectContaining({ order_id: orderId, total_amount: '480' }) }),
    }));
  });

  it('rechaza lotes sin ubicación antes de publicar una reserva cobrable', async () => {
    db.processedEvent = { findUnique: jest.fn().mockResolvedValue(null) };
    tx.processedEvent = { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) };
    jest.spyOn(service, 'reserve').mockResolvedValue({ reservation: reservation(), stock: { farm_id: null } } as any);
    const release = jest.spyOn(service as any, 'releaseCheckoutReservations').mockResolvedValue(undefined);
    const event: any = {
      event_id: '99999999-9999-4999-8999-999999999999', event_type: 'order.created', source_service: 'order-service',
      entity_id: '77777777-7777-4777-8777-777777777777', entity_version: 1, schema_version: 1,
      correlation_id: '99999999-9999-4999-8999-999999999999',
      payload: { checkout_mode: 'async_saga', order_id: '77777777-7777-4777-8777-777777777777', buyer_id: buyerId,
        items: [{ order_item_id: '88888888-8888-4888-8888-888888888888', product_id: productId, quantity_kg: 4 }] },
    };
    await expect(service.reserveCheckoutOrder(event)).resolves.toMatchObject({ reserved: false });
    expect(release).toHaveBeenCalled();
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'inventory.order_reservation_failed' }) }));
    expect(tx.outboxEvent.create).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'inventory.order_reserved' }) }));
  });

  it('no publica checkout reservado si una repetición devuelve una reserva ya liberada', async () => {
    const orderId = '77777777-7777-4777-8777-777777777777';
    const orderItemId = '88888888-8888-4888-8888-888888888888';
    const eventId = '99999999-9999-4999-8999-999999999999';
    db.processedEvent = { findUnique: jest.fn().mockResolvedValue(null) };
    tx.processedEvent = { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue({}) };
    jest.spyOn(service, 'reserve').mockResolvedValue({
      reservation: reservation(undefined, { status: 'released' }),
      stock: { batch_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', farm_id: 'bbbbbbbb-bbbb-4bbb-8bbb-777777777777', pickup_address: 'Finca La Esperanza', pickup_latitude: 8.7, pickup_longitude: -75.8 },
    } as any);
    const event: any = {
      event_id: eventId, event_type: 'order.created', source_service: 'order-service', entity_id: orderId,
      entity_version: 1, schema_version: 1, correlation_id: eventId, occurred_at: new Date().toISOString(),
      payload: { checkout_mode: 'async_saga', order_id: orderId, buyer_id: buyerId, total_amount: '480', currency: 'COP', items: [{ order_item_id: orderItemId, product_id: productId, quantity_kg: 4, subtotal: '480' }] },
    };

    await expect(service.reserveCheckoutOrder(event)).resolves.toMatchObject({ reserved: false });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'inventory.order_reservation_failed' }),
    }));
    expect(tx.outboxEvent.create).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ eventType: 'inventory.order_reserved' }),
    }));
  });

  it('ignora order.created del checkout REST legado para no reservar stock dos veces', async () => {
    const event: any = {
      event_id: '99999999-9999-4999-8999-999999999999', event_type: 'order.created', source_service: 'order-service',
      entity_id: '77777777-7777-4777-8777-777777777777', entity_version: 1, schema_version: 1,
      correlation_id: '88888888-8888-4888-8888-888888888888', occurred_at: new Date().toISOString(),
      payload: { order_id: '77777777-7777-4777-8777-777777777777', buyer_id: buyerId, items: [] },
    };
    const reserve = jest.spyOn(service, 'reserve');

    await expect(service.reserveCheckoutOrder(event)).resolves.toEqual({ ignored: true });
    expect(reserve).not.toHaveBeenCalled();
  });
});
