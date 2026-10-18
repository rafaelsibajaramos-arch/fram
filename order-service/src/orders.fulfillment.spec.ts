import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';

const orderId = 'da3b2a36-6633-4a18-9b6a-9ebad49c7158';
const event = {
  event_id: '6b4c2429-0c8d-485d-85a2-a2a5cc1d4111', event_type: 'order.fulfillment_closed', source_service: 'logistics-service',
  entity_id: 'e843ec3e-2e65-4cb0-8143-35e7d58297d0', entity_version: 1, schema_version: 1,
  occurred_at: '2026-10-17T12:00:00.000Z', correlation_id: 'd9545aee-7c4f-46cc-afeb-f6dc2111ed21',
  payload: { order_id: orderId, accepted_amount: '750', items: [{ order_item_id: orderId, quantity_ordered_kg: '10', accepted_quantity_kg: '6', accepted_amount: '750' }] },
};

describe('order fulfillment consumer', () => {
  it('marks a partially accepted order and its settlement status atomically', async () => {
    const calls: string[] = [];
    const updated = { id: orderId, status: OrderStatus.partial, paymentStatus: PaymentStatus.captured, items: [] };
    const tx: any = {
      processedEvent: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockImplementation(async () => calls.push('inbox')) },
      orderItem: { update: jest.fn().mockResolvedValue({}) },
      order: { findUnique: jest.fn().mockResolvedValue({ id: orderId, status: OrderStatus.confirmed, totalAmount: new Prisma.Decimal(1000), items: [{ id: orderId, quantity: new Prisma.Decimal(10), unitPrice: new Prisma.Decimal(125) }] }), update: jest.fn().mockImplementation(async () => { calls.push('update'); return updated; }) },
    };
    const prisma: any = { $transaction: jest.fn((callback) => callback(tx)) };

    const result = await new OrdersService(prisma).consumeFulfillmentClosed(event);

    expect(result.status).toBe(OrderStatus.partial);
    expect(result.paymentStatus).toBe(PaymentStatus.captured);
    expect(calls).toEqual(['update', 'inbox']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('marks an entirely rejected order cancelled and voids payment state', async () => {
    const tx: any = {
      processedEvent: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      order: { findUnique: jest.fn().mockResolvedValue({ id: orderId, status: OrderStatus.dispatched }), update: jest.fn().mockResolvedValue({ status: OrderStatus.cancelled, paymentStatus: PaymentStatus.voided }) },
    };
    const prisma: any = { $transaction: (callback: any) => callback(tx) };
    tx.orderItem = { update: jest.fn().mockResolvedValue({}) };
    tx.order.findUnique.mockResolvedValue({ id: orderId, status: OrderStatus.dispatched, totalAmount: new Prisma.Decimal(1000), items: [{ id: orderId, quantity: new Prisma.Decimal(10), unitPrice: new Prisma.Decimal(125) }] });
    const failed = { ...event, event_id: '5f44770f-07aa-4b54-9d82-4fe166498723', payload: { order_id: orderId, accepted_amount: '0', items: [{ order_item_id: orderId, quantity_ordered_kg: '10', accepted_quantity_kg: '0', accepted_amount: '0' }] } };

    const result = await new OrdersService(prisma).consumeFulfillmentClosed(failed);

    expect(result.status).toBe(OrderStatus.cancelled);
    expect(result.paymentStatus).toBe(PaymentStatus.voided);
  });
});
