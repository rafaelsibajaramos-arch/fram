import { ConflictException, ForbiddenException } from '@nestjs/common';
import { OrderStatus, PaymentStatus, Prisma } from '@prisma/client';
import { OrdersService } from './orders.service';

const orderId = 'da3b2a36-6633-4a18-9b6a-9ebad49c7158';
const buyerId = 'd5f03741-1e3b-425b-8caa-0fb9da83b328';
const ratingId = 'afc410bd-9425-4bc2-8152-5d13b1c5c6a7';

describe('order rating', () => {
  function setup(order: any, existing: any = null) {
    const ratingFind = jest.fn().mockResolvedValue(existing);
    const ratingCreate = jest.fn().mockResolvedValue({ id: ratingId, orderId, buyerId, score: 5, comment: 'Excelente', createdAt: new Date('2026-10-18T15:00:00Z') });
    const outboxCreate = jest.fn().mockResolvedValue({});
    const tx = { order: { findUnique: jest.fn().mockResolvedValue(order) }, orderRating: { findUnique: ratingFind, create: ratingCreate }, outboxEvent: { create: outboxCreate } };
    const db: any = { $transaction: jest.fn((callback: (tx: any) => unknown) => callback(tx)), orderRating: { findUnique: jest.fn().mockResolvedValue(existing) } };
    return { service: new OrdersService(db), db, tx, ratingFind, ratingCreate, outboxCreate };
  }

  const deliveredOrder = () => ({ buyerId, status: OrderStatus.delivered, paymentStatus: PaymentStatus.captured, items: [{ acceptedQuantity: new Prisma.Decimal('2'), acceptedSubtotal: new Prisma.Decimal('3000') }] });

  it('creates a rating and its analytics event atomically for a paid delivered order', async () => {
    const ctx = setup(deliveredOrder());
    const result = await ctx.service.rate(orderId, buyerId, { score: 5, comment: ' Excelente ' }, '13cb84f7-90b2-4f80-90d0-7bd57c52e10b');
    expect(result.replayed).toBe(false);
    expect(ctx.ratingCreate).toHaveBeenCalledWith({ data: { orderId, buyerId, score: 5, comment: 'Excelente' } });
    expect(ctx.outboxCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'rating.created', routingKey: 'rating.created', aggregateId: ratingId, correlationId: '13cb84f7-90b2-4f80-90d0-7bd57c52e10b', payload: expect.objectContaining({ rating_id: ratingId, order_id: orderId, buyer_id: buyerId, score: 5, comment: 'Excelente' }) }) });
  });

  it('replays the same rating without publishing a duplicate event', async () => {
    const existing = { id: ratingId, orderId, buyerId, score: 5, comment: 'Excelente' };
    const ctx = setup(deliveredOrder(), existing);
    const result = await ctx.service.rate(orderId, buyerId, { score: 5, comment: 'Excelente' });
    expect(result).toEqual({ rating: existing, replayed: true });
    expect(ctx.ratingCreate).not.toHaveBeenCalled();
    expect(ctx.outboxCreate).not.toHaveBeenCalled();
  });

  it('rejects ratings from another buyer and before successful delivery', async () => {
    const wrongBuyer = setup(deliveredOrder());
    await expect(wrongBuyer.service.rate(orderId, 'c0b3816c-46fc-4c66-a4ed-c0d1b328fb11', { score: 5 })).rejects.toBeInstanceOf(ForbiddenException);
    const notDelivered = setup({ ...deliveredOrder(), status: OrderStatus.confirmed });
    await expect(notDelivered.service.rate(orderId, buyerId, { score: 5 })).rejects.toBeInstanceOf(ConflictException);
    expect(notDelivered.outboxCreate).not.toHaveBeenCalled();
  });
});
