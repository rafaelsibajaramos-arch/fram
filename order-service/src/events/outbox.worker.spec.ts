import { OutboxWorker } from './outbox.worker';

describe('OutboxWorker', () => {
  const row = {
    id: 'f08265bb-64f8-44c6-a18b-326682536e6d', eventType: 'order.confirmed',
    aggregateId: '9fda7966-821f-4e0a-9946-96da561ed253', routingKey: null,
    sourceService: 'order-service', entityVersion: 1, schemaVersion: 1,
    correlationId: 'checkout-123', occurredAt: new Date('2026-10-17T12:00:00Z'),
    payload: { orderId: '9fda7966-821f-4e0a-9946-96da561ed253' },
  };

  function setup(connected = true) {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([row]) };
    const prisma: any = {
      $transaction: jest.fn((callback) => callback(tx)),
      outboxEvent: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ attempts: 0 }) },
    };
    const rabbit: any = { isConnected: jest.fn().mockReturnValue(connected), publish: jest.fn().mockResolvedValue(undefined) };
    return { worker: new OutboxWorker(prisma, rabbit), prisma, rabbit, tx };
  }

  it('no reclama eventos si RabbitMQ no está conectado', async () => {
    const { worker, prisma } = setup(false);
    await expect(worker.drain()).resolves.toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('publica el sobre estándar y marca el evento como publicado', async () => {
    const { worker, rabbit, prisma } = setup();
    await expect(worker.drain()).resolves.toBe(1);
    expect(rabbit.publish).toHaveBeenCalledWith('order.confirmed', expect.objectContaining({
      event_id: row.id, event_type: row.eventType, source_service: 'order-service',
      entity_id: row.aggregateId, correlation_id: row.correlationId, payload: row.payload,
    }));
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: row.id }, data: expect.objectContaining({ status: 'published' }),
    }));
  });

  it('registra error e incrementa el intento cuando RabbitMQ falla', async () => {
    const { worker, rabbit, prisma } = setup();
    rabbit.publish.mockRejectedValue(new Error('broker unavailable'));
    await expect(worker.drain()).resolves.toBe(0);
    expect(prisma.outboxEvent.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: row.id }, data: expect.objectContaining({ attempts: { increment: 1 }, status: 'pending' }),
    }));
  });
});
