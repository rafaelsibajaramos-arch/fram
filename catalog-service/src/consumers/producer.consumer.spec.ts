import { CONSUMED_EVENTS, EventEnvelope } from '../events/event-envelope';
import { createPrismaMock } from '../test-utils/prisma.mock';
import { ProducerConsumer } from './producer.consumer';

const PRODUCER_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const PRODUCT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const EVENT_ID = 'cccccccc-1111-4111-8111-cccccccccccc';

const rabbitMock = { register: jest.fn(), isConnected: () => true } as any;

function envelope(tipo: string, over: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    event_id: EVENT_ID,
    event_type: tipo,
    source_service: 'producer-service',
    entity_id: PRODUCER_ID,
    entity_version: 2,
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: '11111111-1111-4111-8111-111111111111',
    payload: { producer_id: PRODUCER_ID, user_id: 'x', full_name: 'Juan' },
    ...over,
  };
}

describe('ProducerConsumer', () => {
  let prisma: any;
  let products: any;
  let consumer: ProducerConsumer;

  beforeEach(() => {
    prisma = createPrismaMock();
    products = {
      disableAllByProducer: jest.fn().mockResolvedValue([PRODUCT_ID]),
      invalidarCache: jest.fn().mockResolvedValue(undefined),
    };
    consumer = new ProducerConsumer(prisma, rabbitMock, products);
    prisma.tx.processedEvent.findUnique.mockResolvedValue(null);
    prisma.tx.producerRef.findUnique.mockResolvedValue(null);
  });

  it('guarda la referencia local con producer.created', async () => {
    await consumer.handle(envelope(CONSUMED_EVENTS.producerCreated, { entity_version: 1, payload: { producer_id: PRODUCER_ID, status: 'active', full_name: 'Juan' } }));

    expect(prisma.tx.producerRef.upsert).toHaveBeenCalled();
    expect(products.disableAllByProducer).not.toHaveBeenCalled();
  });

  it('con producer.disabled retira los productos y marca la referencia', async () => {
    await consumer.handle(envelope(CONSUMED_EVENTS.producerDisabled));

    expect(products.disableAllByProducer).toHaveBeenCalledWith(
      PRODUCER_ID,
      expect.any(String),
      prisma.tx,
    );
    const datos = prisma.tx.producerRef.upsert.mock.calls[0][0];
    expect(datos.create.status).toBe('disabled');
  });

  it('invalida la cache SOLO despues de confirmar la transaccion', async () => {
    const orden: string[] = [];
    prisma.$transaction.mockImplementation(async (fn: any) => {
      const r = await fn(prisma.tx);
      orden.push('commit');
      return r;
    });
    products.invalidarCache.mockImplementation(async () => {
      orden.push('invalidar');
    });

    await consumer.handle(envelope(CONSUMED_EVENTS.producerDisabled));

    // Si se invalidara dentro, una lectura previa al commit recachearia el
    // producto todavia activo durante todo el TTL.
    expect(orden).toEqual(['commit', 'invalidar']);
  });

  it('no invalida nada si no se retiro ningun producto', async () => {
    products.disableAllByProducer.mockResolvedValue([]);
    await consumer.handle(envelope(CONSUMED_EVENTS.producerDisabled));
    expect(products.invalidarCache).not.toHaveBeenCalled();
  });

  it('es idempotente ante un event_id repetido', async () => {
    prisma.tx.processedEvent.findUnique.mockResolvedValue({ eventId: EVENT_ID });

    await consumer.handle(envelope(CONSUMED_EVENTS.producerDisabled));

    expect(prisma.tx.producerRef.upsert).not.toHaveBeenCalled();
    expect(products.disableAllByProducer).not.toHaveBeenCalled();
  });

  it('ignora un evento con una version anterior a la conocida', async () => {
    prisma.tx.producerRef.findUnique.mockResolvedValue({ producerId: PRODUCER_ID, status: 'disabled', version: 5 });

    await consumer.handle(envelope(CONSUMED_EVENTS.producerUpdated, { entity_version: 3 }));

    expect(prisma.tx.producerRef.upsert).not.toHaveBeenCalled();
  });

  it('descarta el evento si no trae producer_id', async () => {
    await consumer.handle(envelope(CONSUMED_EVENTS.producerUpdated, { payload: {}, entity_id: '' as any }));
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
