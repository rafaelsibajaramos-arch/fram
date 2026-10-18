import { ConflictException } from '@nestjs/common';
import { OrdersService } from './orders.service';

const buyerId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const paymentId = '33333333-3333-4333-8333-333333333333';
const reservationId = '44444444-4444-4444-8444-444444444444';
const correlationId = '55555555-5555-4555-8555-555555555555';

describe('OrdersService checkout compensation', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; delete process.env.INTERNAL_API_KEY; });

  it('espera la liberación de reservas parciales antes de fallar el checkout', async () => {
    const productA = '66666666-6666-4666-8666-666666666666';
    const productB = '99999999-9999-4999-8999-999999999999';
    let markReleaseStarted!: () => void;
    let finishRelease!: () => void;
    const releaseStarted = new Promise<void>((resolve) => { markReleaseStarted = resolve; });
    const releaseGate = new Promise<void>((resolve) => { finishRelease = resolve; });
    const prisma: any = { order: { findUnique: jest.fn().mockResolvedValue(null) } };
    const fetchMock = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('http://catalog/')) {
        const productId = url.endsWith(productA) ? productA : productB;
        return response(200, { active: true, price: 100, price_version_id: null, producer_id: buyerId, name: productId === productA ? 'Producto A' : 'Producto B', min_order_quantity: 1 });
      }
      if (url === 'http://inventory/inventory/reservations') {
        const body = JSON.parse(String(init?.body));
        if (body.product_id === productA) return response(201, { reservation: { id: reservationId }, stock: { batch_id: orderId, farm_id: paymentId, pickup_address: 'Finca', pickup_latitude: 8.7, pickup_longitude: -75.8 } });
        return response(409, { message: 'stock insuficiente' });
      }
      if (url === `http://inventory/inventory/reservations/${reservationId}/release`) {
        markReleaseStarted();
        await releaseGate;
        return response(200, {});
      }
      throw new Error(`Unexpected request ${url}`);
    });
    global.fetch = fetchMock as typeof fetch;
    const service = new OrdersService(prisma);

    const checkout = service.create(
      { buyerId, deliveryAddress: 'Calle 1', idempotencyKey: 'partial-reservation', items: [{ productId: productA, quantity: 1 }, { productId: productB, quantity: 1 }] },
      buyerId, 'buyer-jwt', undefined, undefined,
      { catalog: 'http://catalog', inventory: 'http://inventory' }, correlationId,
    );
    await releaseStarted;
    let settled = false;
    void checkout.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishRelease();
    await expect(checkout).rejects.toBeInstanceOf(ConflictException);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`http://inventory/inventory/reservations/${reservationId}/release`);
  });

  it('anula el saldo y cancela el pedido cuando Inventario rechaza atómicamente sus reservas', async () => {
    process.env.INTERNAL_API_KEY = 'test-internal-key';
    const order = {
      id: orderId, buyerId, status: 'pending', totalAmount: 1200, currency: 'COP',
      items: [{ reservationId, productId: '66666666-6666-4666-8666-666666666666', quantity: 2, unitPrice: 600, harvestBatchId: '77777777-7777-4777-8777-777777777777', farmId: '88888888-8888-4888-8888-888888888888', pickupAddress: 'Finca La Esperanza', pickupLatitude: 8.7, pickupLongitude: -75.8 }],
    };
    const tx = {
      order: { update: jest.fn().mockResolvedValue({ ...order, status: 'cancelled' }) },
      outboxEvent: { create: jest.fn().mockResolvedValue({}) },
      cart: { findUnique: jest.fn().mockResolvedValue(null) },
      cartItem: { deleteMany: jest.fn() },
    };
    const prisma: any = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response(200, { id: paymentId, status: 'authorized' }))
      .mockResolvedValueOnce(response(409, { message: 'reservation expired' }))
      .mockResolvedValueOnce(response(200, { id: paymentId, status: 'voided' }))
      .mockResolvedValueOnce(response(200, {}));
    global.fetch = fetchMock as typeof fetch;

    const service = new OrdersService(prisma);
    await expect(service.checkout(
      { buyerId, deliveryAddress: 'Calle 1', currency: 'COP', idempotencyKey: 'checkout-1', items: [{ productId: order.items[0].productId, quantity: 2 }] },
      buyerId, 'buyer-jwt', undefined, undefined,
      { payment: 'http://payment', inventory: 'http://inventory' }, correlationId,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1][0]).toBe('http://inventory/inventory/reservations/consume-batch');
    expect(fetchMock.mock.calls[2][0]).toBe(`http://payment/api/v1/payments/${paymentId}/void`);
    expect(fetchMock.mock.calls[2][1].headers['x-internal-api-key']).toBe('test-internal-key');
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: orderId }, data: expect.objectContaining({ status: 'cancelled', paymentStatus: 'voided' }) }));
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'order.cancelled', correlationId }) }));
  });
  it('no cobra pedidos sin snapshot de finca y libera su reserva', async () => {
    const order = { id: orderId, buyerId, status: 'pending', totalAmount: 1200, currency: 'COP', items: [{ reservationId, productId: '66666666-6666-4666-8666-666666666666', quantity: 2, unitPrice: 600 }] };
    const tx = { order: { update: jest.fn().mockResolvedValue({ ...order, status: 'cancelled' }) }, outboxEvent: { create: jest.fn().mockResolvedValue({}) } };
    const prisma: any = { order: { findUnique: jest.fn().mockResolvedValue(order) }, $transaction: jest.fn((callback) => callback(tx)) };
    const fetchMock = jest.fn().mockResolvedValue(response(200, {}));
    global.fetch = fetchMock as typeof fetch;

    const service = new OrdersService(prisma);
    await expect(service.checkout(
      { buyerId, deliveryAddress: 'Calle 1', currency: 'COP', idempotencyKey: 'checkout-old', items: [{ productId: order.items[0].productId, quantity: 2 }] },
      buyerId, 'buyer-jwt', undefined, undefined, { payment: 'http://payment', inventory: 'http://inventory' }, correlationId,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`http://inventory/inventory/reservations/${reservationId}/release`);
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled', paymentStatus: 'failed' }) }));
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'order.cancelled' }) }));
  });

  it('no reanima un pedido cancelado al reintentar la misma clave', async () => {
    const prisma: any = { order: { findUnique: jest.fn().mockResolvedValue({ id: orderId, buyerId, status: 'cancelled' }) } };
    const fetchMock = jest.fn();
    global.fetch = fetchMock as typeof fetch;
    const service = new OrdersService(prisma);
    await expect(service.checkout(
      { buyerId, deliveryAddress: 'Calle 1', idempotencyKey: 'checkout-cancelled', items: [] }, buyerId, 'buyer-jwt', undefined, undefined, {}, correlationId,
    )).rejects.toBeInstanceOf(ConflictException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancela y libera las reservas cuando el simulador rechaza definitivamente el pago', async () => {
    const order = {
      id: orderId, buyerId, status: 'pending', paymentStatus: 'pending', totalAmount: 1200, currency: 'COP',
      items: [{ reservationId, productId: '66666666-6666-4666-8666-666666666666', quantity: 2, unitPrice: 600, harvestBatchId: '77777777-7777-4777-8777-777777777777', farmId: '88888888-8888-4888-8888-888888888888', pickupAddress: 'Finca La Esperanza', pickupLatitude: 8.7, pickupLongitude: -75.8 }],
    };
    const tx = {
      order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      outboxEvent: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response(409, { message: 'Saldo insuficiente' }))
      .mockResolvedValueOnce(response(200, {}));
    global.fetch = fetchMock as typeof fetch;
    const service = new OrdersService(prisma);

    await expect(service.checkout(
      { buyerId, deliveryAddress: 'Calle 1', currency: 'COP', idempotencyKey: 'checkout-no-funds', items: [{ productId: order.items[0].productId, quantity: 2 }] },
      buyerId, 'buyer-jwt', undefined, undefined,
      { payment: 'http://payment', inventory: 'http://inventory' }, correlationId,
    )).rejects.toBeInstanceOf(ConflictException);

    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: orderId, status: 'pending', paymentStatus: 'pending' },
      data: { status: 'cancelled', paymentStatus: 'failed' },
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'order.cancelled', correlationId }) }));
    expect(fetchMock.mock.calls[1][0]).toBe(`http://inventory/inventory/reservations/${reservationId}/release`);
  });

  it('conserva el checkout y no libera stock ante un error transitorio de Pagos', async () => {
    const order = {
      id: orderId, buyerId, status: 'pending', paymentStatus: 'pending', totalAmount: 1200, currency: 'COP',
      items: [{ reservationId, productId: '66666666-6666-4666-8666-666666666666', quantity: 2, unitPrice: 600, harvestBatchId: '77777777-7777-4777-8777-777777777777', farmId: '88888888-8888-4888-8888-888888888888', pickupAddress: 'Finca La Esperanza', pickupLatitude: 8.7, pickupLongitude: -75.8 }],
    };
    const cancelTransaction = jest.fn();
    const prisma: any = { order: { findUnique: jest.fn().mockResolvedValue(order) }, $transaction: cancelTransaction };
    const fetchMock = jest.fn()
      .mockResolvedValueOnce(response(503, { message: 'temporalmente no disponible' }))
      .mockResolvedValueOnce(response(404, { message: 'Pago aún no registrado' }));
    global.fetch = fetchMock as typeof fetch;
    const service = new OrdersService(prisma);

    await expect(service.checkout(
      { buyerId, deliveryAddress: 'Calle 1', currency: 'COP', idempotencyKey: 'checkout-payment-outage', items: [{ productId: order.items[0].productId, quantity: 2 }] },
      buyerId, 'buyer-jwt', undefined, undefined,
      { payment: 'http://payment', inventory: 'http://inventory' }, correlationId,
    )).rejects.toThrow('No se pudo completar el pago');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`http://payment/api/v1/payments/by-order/${orderId}`);
    expect(cancelTransaction).not.toHaveBeenCalled();
    expect(order.status).toBe('pending');
  });

  it('recupera una autorización ya guardada si se perdió la respuesta del POST de Pagos', async () => {
    const order = {
      id: orderId, buyerId, status: 'pending', paymentStatus: 'pending', totalAmount: 1200, currency: 'COP',
      items: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reservationId, productId: '66666666-6666-4666-8666-666666666666', productName: 'Naranja', producerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', producerName: 'Finca Verde', quantity: 2, unitPrice: 600, subtotal: 1200, harvestBatchId: '77777777-7777-4777-8777-777777777777', farmId: '88888888-8888-4888-8888-888888888888', pickupAddress: 'Finca La Esperanza', pickupLatitude: 8.7, pickupLongitude: -75.8 }],
    };
    const confirmedOrder = { ...order, status: 'confirmed', paymentStatus: 'authorized' };
    const tx = {
      order: { update: jest.fn().mockResolvedValue(confirmedOrder) },
      cart: { findUnique: jest.fn().mockResolvedValue(null) },
      cartItem: { deleteMany: jest.fn() },
      outboxEvent: { create: jest.fn() },
    };
    const prisma: any = {
      order: { findUnique: jest.fn().mockResolvedValue(order) },
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const fetchMock = jest.fn()
      .mockRejectedValueOnce(new Error('socket hang up after server commit'))
      .mockResolvedValueOnce(response(200, { id: paymentId, orderId, buyerId, status: 'authorized' }))
      .mockResolvedValueOnce(response(200, { consumed: true }));
    global.fetch = fetchMock as typeof fetch;
    const service = new OrdersService(prisma);

    const result = await service.checkout(
      { buyerId, deliveryAddress: 'Calle 1', currency: 'COP', idempotencyKey: 'checkout-lost-payment-response', items: [{ productId: order.items[0].productId, quantity: 2 }] },
      buyerId, 'buyer-jwt', undefined, undefined,
      { payment: 'http://payment', inventory: 'http://inventory' }, correlationId,
    );

    expect(result.order).toBe(confirmedOrder);
    expect(result.payment).toMatchObject({ id: paymentId, status: 'authorized' });
    expect(fetchMock.mock.calls[1][0]).toBe(`http://payment/api/v1/payments/by-order/${orderId}`);
    expect(fetchMock.mock.calls[2][0]).toBe('http://inventory/inventory/reservations/consume-batch');
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ eventType: 'order.confirmed' }) }));
  });
});

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
