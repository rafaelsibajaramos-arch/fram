import { ConfigService } from '@nestjs/config';
import { NotificationsService } from './notifications.service';
import { EventEnvelope } from './event-envelope';

const userId = '6df77e5d-3b70-4d9e-b121-cd50e190bc4d';
const eventId = 'd0df2e4d-c711-4aeb-9396-b9e5cb51643b';
const entityId = '2d62d30b-7b83-4a46-86b3-9980cb448d02';

describe('NotificationsService', () => {
  const notificationCreate = jest.fn();
  const notificationUpdate = jest.fn();
  const processedCreate = jest.fn();
  const processedFind = jest.fn();
  const outboxCreate = jest.fn();
  const preferenceFind = jest.fn();
  const db = {
    notificationPreference: { findMany: preferenceFind },
    $transaction: jest.fn(async (fn: (tx: any) => unknown) => fn({
      processedEvent: { findUnique: processedFind, create: processedCreate },
      notification: { create: notificationCreate, update: notificationUpdate },
      outboxEvent: { create: outboxCreate },
    })),
  };
  const config = { get: jest.fn() } as unknown as ConfigService;
  let service: NotificationsService;

  beforeEach(() => {
    jest.clearAllMocks();
    processedFind.mockResolvedValue(null);
    notificationCreate.mockResolvedValue({ id: '8d29acaa-66be-4142-83c7-906c6e97fbde' });
    notificationUpdate.mockResolvedValue({});
    processedCreate.mockResolvedValue({});
    outboxCreate.mockResolvedValue({});
    preferenceFind.mockResolvedValue([]);
    service = new NotificationsService(db as any, config);
  });

  it('stores an in-app notification and its sent event atomically for an identity event', async () => {
    const result = await service.consume(event({
      user_id: userId, email: 'buyer@example.test', full_name: 'Comprador',
    }, 'identity.user_created'));

    expect(result).toEqual({ processed: true, recipients: 1, notifications: 1 });
    expect(notificationCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId, type: 'identity.user_created', channel: 'in_app' }) });
    expect(notificationUpdate).toHaveBeenCalledWith({ where: { id: '8d29acaa-66be-4142-83c7-906c6e97fbde' }, data: expect.objectContaining({ status: 'sent' }) });
    expect(outboxCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ eventType: 'notification.sent' }) });
  });

  it('does not recreate notifications when the same source event is redelivered', async () => {
    processedFind.mockResolvedValue({ eventId });
    await service.consume(event({ user_id: userId, email: 'buyer@example.test' }, 'identity.user_created'));
    expect(notificationCreate).not.toHaveBeenCalled();
    expect(processedCreate).not.toHaveBeenCalled();
  });

  it('does not treat producer IDs or arbitrary strings as user IDs', async () => {
    const result = await service.consume(event({ producer_id: 'not-a-user-id', product_id: entityId }, 'stock.low'));
    expect(result).toEqual({ processed: true, recipients: 0, notifications: 0 });
    expect(preferenceFind).not.toHaveBeenCalled();
  });

  it('resolves producer-owned events to the producer account before persisting the in-app notification', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ user_id: userId }), { status: 200 }));
    const configGet = jest.spyOn(config, 'get').mockImplementation((key: string) => ({
      PRODUCER_SERVICE_URL: 'http://producer-service:3001', INTERNAL_API_KEY: 'test-internal-key',
    } as Record<string, string>)[key] as never);
    try {
      const result = await service.consume(event({ producer_id: entityId, product_id: eventId }, 'stock.low'));
      expect(result).toEqual({ processed: true, recipients: 1, notifications: 1 });
      expect(fetchSpy).toHaveBeenCalledWith(`http://producer-service:3001/internal/producers/${entityId}/user`, expect.objectContaining({ headers: { 'x-internal-api-key': 'test-internal-key' } }));
      expect(notificationCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId, type: 'stock.low', channel: 'in_app' }) });
    } finally {
      fetchSpy.mockRestore();
      configGet.mockRestore();
    }
  });

  it('notifies both buyer and assigned driver for delivery events', async () => {
    const driverId = '7df77e5d-3b70-4d9e-b121-cd50e190bc4d';
    const result = await service.consume(event({ buyer_id: userId, driver_user_id: driverId }, 'delivery.scheduled'));
    expect(result).toEqual({ processed: true, recipients: 2, notifications: 2 });
    expect(notificationCreate).toHaveBeenCalledTimes(2);
    expect(notificationCreate).toHaveBeenNthCalledWith(1, { data: expect.objectContaining({ userId, type: 'delivery.scheduled', channel: 'in_app' }) });
    expect(notificationCreate).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({ userId: driverId, type: 'delivery.scheduled', channel: 'in_app' }) });
  });

  it('sends rating.created to the buyer and makes it mandatory in-app', async () => {
    const result = await service.consume(event({ buyer_id: userId, order_id: entityId, score: 5 }, 'rating.created'));
    expect(result).toEqual({ processed: true, recipients: 1, notifications: 1 });
    expect(notificationCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ userId, type: 'rating.created', channel: 'in_app', title: 'Gracias por calificar tu compra', message: 'Tu calificación de 5 de 5 quedó registrada.' }) });
  });

  it('does not queue email to an account that is not active', async () => {
    preferenceFind.mockResolvedValue([{ id: 'pref-1', channel: 'email', enabled: true }]);
    await service.consume(event({ user_id: userId, email: 'buyer@example.test', status: 'pending_email' }, 'identity.user_created'));

    expect(notificationCreate).toHaveBeenCalledTimes(1);
    expect(notificationCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ channel: 'in_app', userId }) });
  });

  it('rejects malformed envelopes before any database write', async () => {
    await expect(service.consume({ ...event({ user_id: userId }, 'identity.user_created'), correlation_id: 'invalid' })).rejects.toThrow('Sobre de evento inválido');
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

function event(payload: Record<string, unknown>, eventType: string): EventEnvelope {
  return { event_id: eventId, event_type: eventType, source_service: eventType.startsWith('identity.') ? 'identity-service' : 'catalog-service', entity_id: entityId, entity_version: 1, schema_version: 1, occurred_at: '2026-10-17T12:00:00.000Z', correlation_id: 'c274c0f8-ab88-44f0-90b0-aad9c9fd4965', payload };
}
