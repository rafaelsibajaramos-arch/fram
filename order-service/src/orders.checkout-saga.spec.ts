import { Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';

const orderId = '11111111-1111-4111-8111-111111111111';
const buyerId = '22222222-2222-4222-8222-222222222222';
const itemId = '33333333-3333-4333-8333-333333333333';
const reservationId = '44444444-4444-4444-8444-444444444444';
const farmId = '55555555-5555-4555-8555-555555555555';
const batchId = '66666666-6666-4666-8666-666666666666';
const paymentId = '77777777-7777-4777-8777-777777777777';

describe('OrdersService checkout saga', () => {
  it('confirma solo después de persistir pago autorizado y consumo de inventario', async () => {
    const order: any = {
      id: orderId, buyerId, status: 'pending', paymentStatus: 'pending', checkoutInventoryStatus: 'pending',
      inventoryConsumed: false, paymentId: null, totalAmount: new Prisma.Decimal(1200), currency: 'COP',
      deliveryAddress: 'Vereda El Rosario', items: [{ id: itemId, productId: farmId, productName: 'Naranja', producerId: buyerId, producerName: 'Finca Verde', quantity: new Prisma.Decimal(2), unitPrice: new Prisma.Decimal(600), subtotal: new Prisma.Decimal(1200), reservationId: null }],
    };
    const seen = new Set<string>();
    const outbox: any[] = [];
    const tx: any = {
      processedEvent: { findUnique: async ({ where }: any) => seen.has(where.eventId) ? { eventId: where.eventId } : null, create: async ({ data }: any) => { seen.add(data.eventId); } },
      order: {
        findUnique: async () => order,
        findUniqueOrThrow: async () => order,
        update: async ({ data }: any) => { Object.assign(order, data); return order; },
        updateMany: async ({ where, data }: any) => {
          if (order.id !== where.id || order.status !== where.status || order.checkoutInventoryStatus !== where.checkoutInventoryStatus || order.paymentStatus !== where.paymentStatus || order.paymentId !== where.paymentId) return { count: 0 };
          Object.assign(order, data); return { count: 1 };
        },
      },
      orderItem: { update: async ({ where, data }: any) => { const item = order.items.find((row: any) => row.id === where.id); Object.assign(item, data); return item; } },
      cart: { findUnique: async () => null }, cartItem: { deleteMany: async () => ({ count: 0 }) },
      outboxEvent: { create: async ({ data }: any) => { outbox.push(data); } },
    };
    const service = new OrdersService({ $transaction: async (callback: any) => callback(tx) } as any);
    const event = (eventId: string, type: string, source: string, payload: Record<string, unknown>) => ({
      event_id: eventId, event_type: type, source_service: source, entity_id: orderId,
      entity_version: 1, schema_version: 1, correlation_id: eventId, occurred_at: new Date().toISOString(), payload,
    });

    await service.consumeCheckoutSagaEvent(event('88888888-8888-4888-8888-888888888888', 'inventory.order_reserved', 'inventory-service', {
      order_id: orderId, buyer_id: buyerId, items: [{ order_item_id: itemId, product_id: farmId, quantity_kg: '2', reservation_id: reservationId, harvest_batch_id: batchId, farm_id: farmId, pickup_address: 'Finca Verde', pickup_latitude: '8.7', pickup_longitude: '-75.8' }],
    }));
    await service.consumeCheckoutSagaEvent(event('99999999-9999-4999-8999-999999999999', 'payment.checkout_authorized', 'payment-service', { order_id: orderId, buyer_id: buyerId, payment_id: paymentId, amount: '1200', currency: 'COP' }));
    expect(order.status).toBe('pending');
    expect(outbox.some((row) => row.eventType === 'order.confirmed')).toBe(false);

    await service.consumeCheckoutSagaEvent(event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'inventory.checkout_consumed', 'inventory-service', { order_id: orderId, buyer_id: buyerId }));

    expect(order.status).toBe('confirmed');
    expect(order.inventoryConsumed).toBe(true);
    expect(outbox.filter((row) => row.eventType === 'order.confirmed')).toHaveLength(1);
    expect(outbox.find((row) => row.eventType === 'order.confirmed').payload.deliveryAddress).toBe('Vereda El Rosario');
  });
});
