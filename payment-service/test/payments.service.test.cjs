const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PaymentsService } = require('../dist/payments.service.js');
const { PaymentsController } = require('../dist/payments.controller.js');
const { AuthGuard } = require('../dist/auth.guard.js');
const { ForbiddenException } = require('@nestjs/common');

test('el bloqueo de despacho reserva una autorización y evita anularla hasta liberar la ruta', async () => {
  const previousKey = process.env.INTERNAL_API_KEY;
  const routeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const amount = { toString: () => '1200' };
  const state = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount, capturedAmount: amount, currency: 'COP', status: 'authorized', fulfillmentRouteId: null };
  const tx = {
    payment: {
      findUnique: async () => ({ ...state }),
      findUniqueOrThrow: async () => ({ ...state }),
      updateMany: async ({ where, data }) => {
        if (state.status !== where.status || state.fulfillmentRouteId !== where.fulfillmentRouteId) return { count: 0 };
        Object.assign(state, data);
        return { count: 1 };
      },
    },
    wallet: { findUniqueOrThrow: async () => ({ id: ids.wallet }), update: async () => ({ id: ids.wallet, balance: { toString: () => '100' } }) },
    walletTransaction: { create: async () => ({}) },
    outboxEvent: { create: async () => ({}) },
  };
  const service = new PaymentsService({ $transaction: async (callback) => callback(tx) });

  try {
    await service.lockForFulfillment(ids.payment, routeId);
    assert.equal(state.fulfillmentRouteId, routeId);
    await assert.rejects(service.voidAuthorization(ids.payment), /reservado para una ruta/);
    assert.equal(state.status, 'authorized');

    await service.unlockForFulfillment(ids.payment, routeId);
    assert.equal(state.fulfillmentRouteId, null);
    await service.voidAuthorization(ids.payment);
    assert.equal(state.status, 'voided');
  } finally {
    if (previousKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = previousKey;
  }
});

test('solo la clave interna permite autenticación de servicio en endpoints de bloqueo logístico', async () => {
  const previousKey = process.env.INTERNAL_API_KEY;
  process.env.INTERNAL_API_KEY = 'internal-test-key';
  const guard = new AuthGuard({});
  const contextFor = (request) => ({ switchToHttp: () => ({ getRequest: () => request }) });
  const validRequest = { path: `/api/v1/payments/${ids.payment}/fulfillment-lock`, headers: { 'x-internal-api-key': 'internal-test-key' } };
  const invalidRequest = { ...validRequest, headers: { 'x-internal-api-key': 'wrong-key' } };
  try {
    assert.equal(await guard.canActivate(contextFor(validRequest)), true);
    assert.equal(validRequest.user.service, true);
    await assert.rejects(guard.canActivate(contextFor(invalidRequest)), /Falta el token Bearer/);
  } finally {
    if (previousKey === undefined) delete process.env.INTERNAL_API_KEY;
    else process.env.INTERNAL_API_KEY = previousKey;
  }
});

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

test('autoriza checkout solo con evento de reserva consistente y publica resultado idempotente', async () => {
  const Decimal = require('@prisma/client').Prisma.Decimal;
  const writes = [];
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount: new Decimal(1200), currency: 'COP', status: 'authorized' };
  const tx = {
    processedEvent: { findUnique: async () => null, create: async ({ data }) => writes.push(['inbox', data]) },
    outboxEvent: { create: async ({ data }) => writes.push(['outbox', data]) },
  };
  const service = new PaymentsService({ processedEvent: { findUnique: async () => null }, $transaction: async (callback) => callback(tx) });
  service.create = async (dto, _buyer, correlation) => {
    assert.deepEqual(dto, { orderId: ids.order, buyerId: ids.buyer, amount: 1200, simulatedCardId: ids.card, currency: 'COP', idempotencyKey: `checkout:${ids.order}` });
    assert.equal(correlation, ids.correlation);
    return payment;
  };
  const event = {
    event_id: ids.correlation, event_type: 'inventory.order_reserved', source_service: 'inventory-service',
    correlation_id: ids.correlation, entity_id: ids.order,
    payload: { order_id: ids.order, buyer_id: ids.buyer, simulated_card_id: ids.card, total_amount: '1200', currency: 'COP', items: [{ order_item_id: ids.orderItem, reservation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', subtotal: '1200' }] },
  };
  assert.equal(await service.authorizeCheckoutFromInventory(event), payment);
  assert.equal(writes.find(([kind]) => kind === 'outbox')[1].eventType, 'payment.checkout_authorized');
  assert.equal(writes.find(([kind]) => kind === 'outbox')[1].payload.payment_id, ids.payment);
});

test('rechaza evento de reserva cuyo total no coincide con sus líneas', async () => {
  const service = new PaymentsService({ processedEvent: { findUnique: async () => null } });
  const event = {
    event_id: ids.correlation, event_type: 'inventory.order_reserved', source_service: 'inventory-service',
    correlation_id: ids.correlation, entity_id: ids.order,
    payload: { order_id: ids.order, buyer_id: ids.buyer, total_amount: '1200', currency: 'COP', items: [{ order_item_id: ids.orderItem, reservation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', subtotal: '1199' }] },
  };
  await assert.rejects(service.authorizeCheckoutFromInventory(event), /total y detalle consistentes/);
});

test('crea pago, débito y evento outbox dentro de una transacción', async () => {
  const calls = [];
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount: { toString: () => '1200' }, capturedAmount: { toString: () => '1200' }, currency: 'COP', status: 'authorized' };
  const tx = {
    simulatedCard: { findFirst: async () => ({ id: ids.card, brand: 'Visa', last4: '0421' }) },
    wallet: {
      findUnique: async () => ({ id: ids.wallet }),
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => ({ id: ids.wallet, balance: { toString: () => '8800' } }),
    },
    payment: { create: async () => payment },
    walletTransaction: { create: async (args) => calls.push(['walletTransaction', args]) },
    outboxEvent: { create: async (args) => calls.push(['outboxEvent', args]) },
  };
  const prisma = { $transaction: async (callback) => callback(tx), payment: { findUnique: async () => null } };
  const result = await new PaymentsService(prisma).create({ orderId: ids.order, buyerId: ids.buyer, amount: 1200, simulatedCardId: ids.card }, ids.buyer, ids.correlation);

  assert.equal(result, payment);
  assert.deepEqual(calls.map(([name]) => name), ['walletTransaction', 'outboxEvent']);
  assert.equal(calls[1][1].data.eventType, 'payment.authorized');
  assert.equal(calls[1][1].data.aggregateId, ids.payment);
  assert.equal(calls[1][1].data.correlationId, ids.correlation);
  assert.equal(calls[1][1].data.payload.order_id, ids.order);
});

test('permite recuperar el pago idempotente a partir de su pedido', async () => {
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, status: 'authorized' };
  const findUnique = async (query) => {
    assert.deepEqual(query, { where: { orderId: ids.order } });
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

test('registra recarga y evento juntos; una recarga idempotente no duplica el evento', async () => {
  const events = [];
  const wallet = { id: ids.wallet, buyerId: ids.buyer, balance: { toString: () => '5000' }, currency: 'COP', version: 1 };
  let existingTransaction = null;
  const tx = {
    walletTransaction: {
      findUnique: async () => existingTransaction,
      create: async () => {},
    },
    wallet: {
      upsert: async () => ({ id: ids.wallet }),
      update: async () => wallet,
      findUnique: async () => wallet,
    },
    outboxEvent: { create: async (args) => events.push(args) },
  };
  const prisma = { $transaction: async (callback) => callback(tx) };
  const service = new PaymentsService(prisma);

  await service.topUp(ids.buyer, { amount: 5000, reason: 'Carga administrativa', idempotencyKey: 'topup-1' }, ids.actor, ids.correlation);
  assert.equal(events.length, 1);
  assert.equal(events[0].data.eventType, 'wallet.topped_up');
  assert.equal(events[0].data.correlationId, ids.correlation);

  existingTransaction = { id: 'already-credited' };
  await service.topUp(ids.buyer, { amount: 5000, reason: 'Carga administrativa', idempotencyKey: 'topup-1' }, ids.actor, ids.correlation);
  assert.equal(events.length, 1);
});

test('genera una tarjeta ficticia con franquicia elegida y datos asignados al azar', async () => {
  let created;
  const service = new PaymentsService({
    wallet: { upsert: async () => ({ id: ids.wallet }) },
    simulatedCard: { create: async ({ data }) => { created = data; return data; } },
  });
  const card = await service.createCard(ids.buyer, { brand: 'Mastercard', holderName: '  Ana Compradora  ' });
  assert.equal(card.brand, 'Mastercard');
  assert.equal(card.holderName, 'Ana Compradora');
  assert.match(card.last4, /^\d{4}$/);
  assert.ok(card.expiryMonth >= 1 && card.expiryMonth <= 12);
  assert.ok(card.expiryYear >= new Date().getFullYear());
  assert.equal('pan' in created, false);
  assert.equal('cvv' in created, false);
});

test('eliminar una tarjeta preserva el saldo común y limita el borrado a su titular', async () => {
  let deletion;
  const service = new PaymentsService({
    wallet: { findUnique: async () => ({ id: ids.wallet }) },
    simulatedCard: { deleteMany: async ({ where }) => { deletion = where; return { count: 1 }; } },
  });
  assert.deepEqual(await service.deleteCard(ids.buyer, ids.card), { deleted: true, sharedBalancePreserved: true });
  assert.deepEqual(deletion, { id: ids.card, walletId: ids.wallet });
});

test('reembolsa una sola vez, revierte la liquidación abierta y emite el evento', async () => {
  const calls = [];
  const Decimal = require('@prisma/client').Prisma.Decimal;
  let status = 'captured';
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount: new Decimal(1200), capturedAmount: new Decimal(1200), currency: 'COP', status };
  const payout = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', producerId: ids.producer, periodStart: new Date('2026-10-01T00:00:00.000Z'), periodEnd: new Date('2026-11-01T00:00:00.000Z'), status: 'scheduled' };
  const payoutItem = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', payoutId: payout.id, paymentId: ids.payment, orderItemId: ids.orderItem, grossAmount: new Decimal(1200), refundAmount: new Decimal(0), commissionAmount: new Decimal(120), netAmount: new Decimal(1080), payout };
  const tx = {
    payment: {
      findUnique: async () => ({ ...payment, status }),
      updateMany: async () => { status = 'refunded'; return { count: 1 }; },
      findUniqueOrThrow: async () => ({ ...payment, status }),
    },
    producerPayoutItem: { findMany: async () => [payoutItem], update: async ({ data }) => calls.push(['payoutItem', data]) },
    refund: { create: async ({ data }) => { calls.push(['refund', data]); return { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ...data }; } },
    settlementAdjustment: { create: async ({ data }) => calls.push(['adjustment', data]), findMany: async () => [] },
    producerPayout: { update: async ({ data }) => { calls.push(['payout', data]); return { ...payout, ...data, grossAmount: new Decimal(data.grossAmount), refundAmount: new Decimal(data.refundAmount), commissionAmount: new Decimal(data.commissionAmount), adjustmentAmount: new Decimal(data.adjustmentAmount), netAmount: new Decimal(data.netAmount) }; } },
    wallet: {
      findUniqueOrThrow: async () => ({ id: ids.wallet }),
      update: async () => ({ balance: new Decimal(10000), version: 2 }),
    },
    walletTransaction: { create: async (args) => calls.push(['walletTransaction', args]) },
    outboxEvent: { create: async (args) => calls.push(['outboxEvent', args]) },
  };
  const prisma = { $transaction: async (callback) => callback(tx) };
  const service = new PaymentsService(prisma);
  const result = await service.refund(ids.payment, ids.correlation);
  const replay = await service.refund(ids.payment, ids.correlation);

  assert.equal(result.status, 'refunded');
  assert.equal(replay.status, 'refunded');
  assert.equal(calls.filter(([name]) => name === 'walletTransaction').length, 1);
  assert.equal(calls.find(([name]) => name === 'payoutItem')[1].commissionAmount, 0);
  assert.equal(calls.find(([name]) => name === 'payoutItem')[1].refundAmount.toString(), '1200');
  const event = calls.find(([name, args]) => name === 'outboxEvent' && args.data.eventType === 'payment.refunded')[1].data;
  assert.equal(event.eventType, 'payment.refunded');
  assert.equal(event.entityVersion, 3);
  assert.equal(event.correlationId, ids.correlation);
});

test('rechaza el segundo reembolso sin acreditar billetera ni encolar evento', async () => {
  let credits = 0;
  let events = 0;
  const tx = {
    payment: {
      findUnique: async () => ({ id: ids.payment, buyerId: ids.buyer, status: 'captured', capturedAmount: new (require('@prisma/client').Prisma.Decimal)(1200) }),
      updateMany: async () => ({ count: 0 }),
    },
    producerPayoutItem: { findMany: async () => [{ grossAmount: new (require('@prisma/client').Prisma.Decimal)(1200), refundAmount: new (require('@prisma/client').Prisma.Decimal)(0) }] },
    wallet: { update: async () => { credits += 1; } },
    outboxEvent: { create: async () => { events += 1; } },
  };
  const prisma = { $transaction: async (callback) => callback(tx) };

  await assert.rejects(new PaymentsService(prisma).refund(ids.payment, ids.correlation), /ya fue procesado/);
  assert.equal(credits, 0);
  assert.equal(events, 0);
});

test('un reembolso posterior a una transferencia crea un ajuste negativo en el siguiente periodo', async () => {
  const Decimal = require('@prisma/client').Prisma.Decimal;
  const calls = [];
  const paidPayout = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', producerId: ids.producer, periodStart: new Date('2026-10-01T00:00:00.000Z'), periodEnd: new Date('2026-11-01T00:00:00.000Z'), status: 'paid' };
  const item = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', payoutId: paidPayout.id, paymentId: ids.payment, orderId: ids.order, orderItemId: ids.orderItem, grossAmount: new Decimal(1200), refundAmount: new Decimal(0), commissionAmount: new Decimal(120), netAmount: new Decimal(1080), payout: paidPayout };
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount: new Decimal(1200), capturedAmount: new Decimal(1200), currency: 'COP', status: 'captured' };
  const nextPayout = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', producerId: ids.producer, periodStart: new Date('2026-11-01T00:00:00.000Z'), periodEnd: new Date('2026-12-01T00:00:00.000Z'), grossAmount: new Decimal(0), refundAmount: new Decimal(0), commissionAmount: new Decimal(0), adjustmentAmount: new Decimal(0), netAmount: new Decimal(0), status: 'carried' };
  const tx = {
    payment: { findUnique: async () => payment, updateMany: async () => ({ count: 1 }), findUniqueOrThrow: async () => ({ ...payment, status: 'refunded' }) },
    producerPayoutItem: { findMany: async () => [item] },
    refund: { create: async () => ({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }) },
    producerPayout: { findUnique: async () => null, create: async () => nextPayout, update: async ({ data }) => { calls.push(['payout', data]); return { ...nextPayout, ...data, adjustmentAmount: new Decimal(data.adjustmentAmount.increment), netAmount: new Decimal(data.netAmount.increment) }; } },
    settlementAdjustment: { create: async ({ data }) => calls.push(['adjustment', data]) },
    wallet: { findUniqueOrThrow: async () => ({ id: ids.wallet }), update: async () => ({ balance: new Decimal(10000) }) },
    walletTransaction: { create: async () => {} },
    outboxEvent: { create: async ({ data }) => calls.push(['outbox', data]) },
  };
  await new PaymentsService({ $transaction: async (callback) => callback(tx) }).refund(ids.payment, ids.correlation);
  assert.equal(calls.find(([name]) => name === 'adjustment')[1].amount.toString(), '-1080');
  assert.equal(calls.find(([name]) => name === 'adjustment')[1].payoutId, nextPayout.id);
  assert.equal(calls.find(([name]) => name === 'payout')[1].status, 'carried');
  assert.ok(calls.some(([name, data]) => name === 'outbox' && data.eventType === 'payout.scheduled'));
});

test('libera una autorización una sola vez y publica payment.voided', async () => {
  const calls = [];
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount: { toString: () => '1200' }, currency: 'COP', status: 'authorized' };
  const tx = {
    payment: {
      findUnique: async () => payment,
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => ({ ...payment, status: 'voided' }),
    },
    wallet: {
      findUniqueOrThrow: async () => ({ id: ids.wallet }),
      update: async () => ({ balance: { toString: () => '10000' } }),
    },
    walletTransaction: { create: async (args) => calls.push(['walletTransaction', args]) },
    outboxEvent: { create: async (args) => calls.push(['outboxEvent', args]) },
  };
  const service = new PaymentsService({ $transaction: async (callback) => callback(tx) });
  const result = await service.voidAuthorization(ids.payment, ids.correlation);

  assert.equal(result.status, 'voided');
  assert.equal(calls[0][1].data.type, 'release');
  assert.equal(calls[0][1].data.idempotencyKey, `void:${ids.payment}`);
  assert.equal(calls[1][1].data.eventType, 'payment.voided');
  assert.equal(calls[1][1].data.entityVersion, 2);
});

test('captura una autorización idempotentemente sin debitar el saldo otra vez', async () => {
  const events = [];
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount: { toString: () => '1200' }, capturedAmount: { toString: () => '1200' }, currency: 'COP', status: 'authorized' };
  const tx = {
    payment: {
      findUnique: async () => payment,
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => ({ ...payment, status: 'captured' }),
    },
    outboxEvent: { create: async (args) => events.push(args) },
    wallet: { update: async () => { throw new Error('capturar no debe debitar de nuevo'); } },
  };
  const service = new PaymentsService({ $transaction: async (callback) => callback(tx) });
  const result = await service.capture(ids.payment, ids.correlation);

  assert.equal(result.status, 'captured');
  assert.equal(events[0].data.eventType, 'payment.captured');
  assert.equal(events[0].data.entityVersion, 2);
});

test('liquida una entrega parcial una sola vez y libera el valor no aceptado', async () => {
  const calls = [];
  const Decimal = require('@prisma/client').Prisma.Decimal;
  const detail = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', paymentId: ids.payment, orderItemId: ids.orderItem, productId: ids.product, producerId: ids.producer, orderedQuantity: new Decimal(10), unitPrice: new Decimal(125), commissionRate: new Decimal(0) };
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount: new Decimal(1000), capturedAmount: new Decimal(0), currency: 'COP', status: 'authorized' };
  const tx = {
    processedEvent: { findUnique: async () => null, create: async (args) => calls.push(['inbox', args]) },
    payment: { findUnique: async () => payment, updateMany: async () => ({ count: 1 }), findUniqueOrThrow: async () => ({ ...payment, status: 'captured', capturedAmount: new (require('@prisma/client').Prisma.Decimal)(750) }) },
    chargeDetail: { findMany: async () => [detail], update: async (args) => calls.push(['chargeDetail', args]) },
    producerPayout: { findUnique: async () => null, create: async ({ data }) => ({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', ...data }), update: async ({ data }) => ({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', adjustmentAmount: new Decimal(0), ...data }) },
    producerPayoutItem: { findUnique: async () => null, create: async ({ data }) => calls.push(['payoutItem', data]), findMany: async () => [{ grossAmount: new Decimal(750), refundAmount: new Decimal(0), commissionAmount: new Decimal(0), netAmount: new Decimal(750) }] },
    settlementAdjustment: { findMany: async () => [] },
    wallet: { findUniqueOrThrow: async () => ({ id: ids.wallet }), update: async ({ data }) => ({ balance: new (require('@prisma/client').Prisma.Decimal)(data.balance.increment), version: 2 }) },
    walletTransaction: { create: async (args) => calls.push(['ledger', args]) },
    outboxEvent: { create: async (args) => calls.push(['outbox', args]) },
  };
  const event = { event_id: ids.correlation, event_type: 'order.fulfillment_closed', source_service: 'logistics-service', correlation_id: ids.correlation, payload: { order_id: ids.order, payment_id: ids.payment, closed_at: '2026-10-18T00:00:00.000Z', accepted_amount: '750.00', items: [{ order_item_id: ids.orderItem, producer_id: ids.producer, quantity_ordered_kg: '10', accepted_quantity_kg: '6', accepted_amount: '750.00' }] } };
  const result = await new PaymentsService({ $transaction: async (callback) => callback(tx) }).settleFulfillment(event);

  assert.equal(result.status, 'captured');
  assert.equal(result.capturedAmount.toString(), '750');
  assert.equal(calls.find(([name]) => name === 'ledger')[1].data.amount.toString(), '250');
  const capturedEvent = calls.find(([name, args]) => name === 'outbox' && args.data.eventType === 'payment.captured');
  assert.equal(capturedEvent[1].data.payload.amount, '750');
  assert.equal(calls.find(([name]) => name === 'payoutItem')[1].netAmount.toString(), '750');
  assert.ok(calls.some(([name, args]) => name === 'outbox' && args.data.eventType === 'payout.scheduled'));
});

test('si no se acepta producto anula la autorización y libera el saldo una sola vez', async () => {
  const Decimal = require('@prisma/client').Prisma.Decimal;
  let inbox = null;
  let status = 'authorized';
  let releases = 0;
  let events = 0;
  const detail = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', paymentId: ids.payment, orderItemId: ids.orderItem, productId: ids.product, producerId: ids.producer, orderedQuantity: new Decimal(10), unitPrice: new Decimal(100), commissionRate: new Decimal(0) };
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount: new Decimal(1000), capturedAmount: new Decimal(0), currency: 'COP', status };
  const tx = {
    processedEvent: { findUnique: async () => inbox, create: async ({ data }) => { inbox = data; } },
    payment: {
      findUnique: async () => ({ ...payment, status }),
      updateMany: async () => { if (status !== 'authorized') return { count: 0 }; status = 'voided'; return { count: 1 }; },
      findUniqueOrThrow: async () => ({ ...payment, status }),
    },
    chargeDetail: { findMany: async () => [detail], update: async () => {} },
    wallet: { findUniqueOrThrow: async () => ({ id: ids.wallet }), update: async ({ data }) => { releases += Number(data.balance.increment.toString()); return { balance: new Decimal(10000) }; } },
    walletTransaction: { create: async () => {} },
    outboxEvent: { create: async () => { events += 1; } },
  };
  const event = { event_id: ids.correlation, event_type: 'order.fulfillment_closed', source_service: 'logistics-service', correlation_id: ids.correlation, payload: { order_id: ids.order, payment_id: ids.payment, accepted_amount: '0', items: [{ order_item_id: ids.orderItem, producer_id: ids.producer, quantity_ordered_kg: '10', accepted_quantity_kg: '0', accepted_amount: '0' }] } };
  const service = new PaymentsService({ $transaction: async (callback) => callback(tx) });

  const first = await service.settleFulfillment(event);
  const replay = await service.settleFulfillment(event);

  assert.equal(first.status, 'voided');
  assert.equal(replay.status, 'voided');
  assert.equal(releases, 1000);
  assert.equal(events, 1);
});

test('repetir la anulación de un pago ya liberado no acredita ni publica por segunda vez', async () => {
  const calls = [];
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount: { toString: () => '1200' }, currency: 'COP', status: 'voided' };
  const tx = {
    payment: { findUnique: async () => payment, updateMany: async () => { calls.push('transition'); return { count: 1 }; } },
    wallet: { update: async () => calls.push('credit') },
    walletTransaction: { create: async () => calls.push('ledger') },
    outboxEvent: { create: async () => calls.push('event') },
  };
  const result = await new PaymentsService({ $transaction: async (callback) => callback(tx) }).voidAuthorization(ids.payment, ids.correlation);

  assert.equal(result.status, 'voided');
  assert.deepEqual(calls, []);
});

test('no permite marcar como fallido un pago autorizado y dejar retenido el saldo', async () => {
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount: { toString: () => '1200' }, currency: 'COP', status: 'authorized' };
  const tx = {
    payment: { findUnique: async () => payment, updateMany: async () => { throw new Error('no debe cambiar el pago'); } },
    wallet: { update: async () => { throw new Error('no debe tocar el saldo'); } },
    outboxEvent: { create: async () => { throw new Error('no debe emitir evento'); } },
  };
  const service = new PaymentsService({ $transaction: async (callback) => callback(tx) });

  await assert.rejects(service.fail(ids.payment, 'rechazo manual', ids.correlation), /Solo se pueden rechazar pagos pendientes/);
});

test('marca pagos pendientes como fallidos en la misma transacción del evento', async () => {
  const events = [];
  const payment = { id: ids.payment, orderId: ids.order, buyerId: ids.buyer, amount: { toString: () => '1200' }, currency: 'COP', status: 'pending' };
  const tx = {
    payment: {
      findUnique: async () => payment,
      updateMany: async () => ({ count: 1 }),
      findUniqueOrThrow: async () => ({ ...payment, status: 'failed', failureReason: 'rechazo manual' }),
    },
    outboxEvent: { create: async (args) => events.push(args) },
  };
  const result = await new PaymentsService({ $transaction: async (callback) => callback(tx) }).fail(ids.payment, 'rechazo manual', ids.correlation);

  assert.equal(result.status, 'failed');
  assert.equal(events[0].data.eventType, 'payment.failed');
  assert.equal(events[0].data.correlationId, ids.correlation);
});
