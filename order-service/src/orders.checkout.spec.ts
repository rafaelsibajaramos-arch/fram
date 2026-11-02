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

});

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}
