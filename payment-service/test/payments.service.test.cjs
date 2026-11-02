const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PaymentsService } = require('../dist/payments.service.js');
const { PaymentsController } = require('../dist/payments.controller.js');
const { AuthGuard } = require('../dist/auth.guard.js');
const { ForbiddenException } = require('@nestjs/common');

const ids = {
  buyer: '22222222-2222-4222-8222-222222222222',
  order: '44444444-4444-4444-8444-444444444444',
  orderItem: '88888888-8888-4888-8888-888888888888',
  product: '99999999-9999-4999-8999-999999999999',
  producer: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  payment: '55555555-5555-4555-8555-555555555555',
  wallet: '66666666-6666-4666-8666-666666666666',
  actor: '77777777-7777-4777-8777-777777777777',
  card: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  correlation: '33333333-3333-4333-8333-333333333333',
};

test('registra el snapshot contable de líneas confirmadas y fija una comisión por línea', async () => {
  const Decimal = require('@prisma/client').Prisma.Decimal;
  const calls = [];
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount: new Decimal(1200), status: 'authorized' };
  const tx = {
    processedEvent: { findUnique: async () => null, create: async ({ data }) => calls.push(['inbox', data]) },
    payment: { findUnique: async () => payment },
    chargeDetail: { findUnique: async () => null, create: async ({ data }) => calls.push(['detail', data]), findMany: async () => [] },
    outboxEvent: { create: async ({ data }) => calls.push(['outbox', data]) },
  };
  const event = { event_id: ids.correlation, event_type: 'order.confirmed', source_service: 'order-service', correlation_id: ids.correlation, entity_id: ids.order, payload: { orderId: ids.order, buyerId: ids.buyer, status: 'confirmed', items: [{ id: ids.orderItem, productId: ids.product, productName: 'Naranja', producerId: ids.producer, quantity: '10', unitPrice: '120' }] } };
  await new PaymentsService({ $transaction: async (callback) => callback(tx) }).registerOrderConfirmed(event);
  const snapshot = calls.find(([name]) => name === 'detail')[1];
  assert.equal(snapshot.productName, 'Naranja');
  assert.equal(snapshot.producerId, ids.producer);
  assert.equal(snapshot.commissionRate.toString(), '0.1');
  assert.ok(calls.some(([name, data]) => name === 'outbox' && data.eventType === 'payment.details_registered'));
});


test('permite recuperar el pago idempotente a partir de su pedido', async () => {
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, status: 'authorized' };
  const findUnique = async (query) => {
    assert.deepEqual(query, { where: { orderId: ids.order }, include: { refundOperations: true } });
    return payment;
  };
  const result = await new PaymentsService({ payment: { findUnique } }).getByOrder(ids.order);
  assert.equal(result, payment);
});


test('la recuperación por pedido solo expone el pago a su comprador o a admin', async () => {
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, status: 'authorized' };
  const controller = new PaymentsController({ getByOrder: async () => payment });
  assert.equal(await controller.getByOrder(ids.order, { user: { sub: ids.buyer, roles: ['buyer'] } }), payment);
  await assert.rejects(
    controller.getByOrder(ids.order, { user: { sub: ids.actor, roles: ['buyer'] } }),
    (error) => error instanceof ForbiddenException,
  );
  assert.equal(await controller.getByOrder(ids.order, { user: { sub: ids.actor, roles: ['admin'] } }), payment);
});

