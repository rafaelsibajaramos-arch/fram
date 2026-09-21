import { ConfigService } from '@nestjs/config';
import { createOutboxMock, createPrismaMock } from '../test-utils/prisma.mock';
import { CONSUMED_EVENTS, EventEnvelope, PRODUCER_EVENTS } from './event-envelope';
import { IdentityConsumer } from './identity.consumer';

const USER_ID = '33333333-3333-4333-8333-333333333333';
const PRODUCER_ID = '44444444-4444-4444-8444-444444444444';
const EVENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const configMock = {
  getOrThrow: () => ({ serviceName: 'producer-service', nodeEnv: 'test' }),
} as unknown as ConfigService;

const rabbitMock = { register: jest.fn(), isConnected: () => true } as any;

function envelope(over: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: EVENT_ID,
    event_type: CONSUMED_EVENTS.identityUserDisabled,
    source_service: 'identity-service',
    entity_id: USER_ID,
    entity_version: 3,
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    payload: { user_id: USER_ID },
    ...over,
  };
}

function producerRow(over: Record<string, unknown> = {}) {
  return { id: PRODUCER_ID, userId: USER_ID, status: 'active', version: 1, ...over };
}

describe('IdentityConsumer', () => {
  let prisma: any;
  let outbox: any;
  let consumer: IdentityConsumer;

  beforeEach(() => {
    prisma = createPrismaMock();
    outbox = createOutboxMock();
    consumer = new IdentityConsumer(prisma, rabbitMock, outbox, configMock);
  });

  it('deshabilita al productor y encola producer.disabled', async () => {
    prisma.tx.processedEvent.findUnique.mockResolvedValue(null);
    prisma.tx.producer.findUnique.mockResolvedValue(producerRow());
    prisma.tx.producer.update.mockResolvedValue(producerRow({ status: 'disabled', version: 2 }));

    await consumer.handle(envelope());

    expect(prisma.tx.producer.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'disabled' }) }),
    );
    expect(outbox.enqueue.mock.calls[0][1]).toMatchObject({
      eventType: PRODUCER_EVENTS.disabled,
      entityId: PRODUCER_ID,
    });
  });

  it('es idempotente: un event_id repetido no vuelve a actualizar', async () => {
    prisma.tx.processedEvent.findUnique.mockResolvedValue({ eventId: EVENT_ID });

    await consumer.handle(envelope());

    expect(prisma.tx.producer.update).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('no falla si el user_id no tiene perfil de productor', async () => {
    prisma.tx.processedEvent.findUnique.mockResolvedValue(null);
    prisma.tx.producer.findUnique.mockResolvedValue(null);

    await expect(consumer.handle(envelope())).resolves.toBeUndefined();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('no republica si el productor ya estaba deshabilitado', async () => {
    prisma.tx.processedEvent.findUnique.mockResolvedValue(null);
    prisma.tx.producer.findUnique.mockResolvedValue(producerRow({ status: 'disabled' }));

    await consumer.handle(envelope());

    expect(prisma.tx.producer.update).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  });

  it('descarta el evento si no trae user_id', async () => {
    await consumer.handle(envelope({ payload: {}, entity_id: '' as any }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
