import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

describe('OrdersController checkout routes', () => {
  const buyerId = '11111111-1111-4111-8111-111111111111';
  const correlationId = '22222222-2222-4222-8222-222222222222';
  const dto = { buyerId, deliveryAddress: 'Test address', items: [] } as never;
  const request = {
    user: { sub: buyerId, roles: ['buyer'] },
    bearer: 'test-access-token',
    headers: { 'x-correlation-id': correlationId },
  } as never;
  const response = { order: { id: 'order-1', status: 'pending' }, processing: true, replayed: false };
  let service: { startCheckoutSaga: jest.Mock };
  let controller: OrdersController;

  beforeEach(() => {
    service = { startCheckoutSaga: jest.fn().mockResolvedValue(response) };
    controller = new OrdersController(service as unknown as OrdersService);
  });

  it.each(['create', 'checkout', 'checkoutAsync'] as const)(
    'routes POST %s through the same asynchronous checkout saga',
    async (route) => {
      await controller[route](dto, request);
      expect(service.startCheckoutSaga).toHaveBeenCalledTimes(1);
      expect(service.startCheckoutSaga).toHaveBeenCalledWith(
        dto,
        buyerId,
        'test-access-token',
        undefined,
        undefined,
        { catalog: undefined, inventory: undefined, payment: undefined, producer: undefined },
        correlationId,
      );
    },
  );
});
