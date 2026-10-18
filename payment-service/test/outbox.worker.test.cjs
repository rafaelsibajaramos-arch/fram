const assert = require('node:assert/strict');
const { test } = require('node:test');
const { OutboxWorker } = require('../dist/outbox.worker.js');

const sample = () => ({
  id: '11111111-1111-4111-8111-111111111111',
  eventType: 'payment.authorized',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  payload: { payment_id: '22222222-2222-4222-8222-222222222222', amount: '1200.00' },
  createdAt: new Date('2026-10-17T12:00:00.000Z'),
  correlationId: '33333333-3333-4333-8333-333333333333',
  entityVersion: 1,
  schemaVersion: 1,
  attempts: 0,
});

function setup(rows = [sample()], publish = async () => {}) {
  const updates = [];
  const db = {
    $queryRaw: async () => rows,
    outboxEvent: { update: async (args) => updates.push(args) },
  };
  const events = { isConnected: () => true, publish };
  return { worker: new OutboxWorker(db, events), db, events, updates };
}

test('publica un sobre de dominio y marca el evento como entregado', async () => {
  const published = [];
  const { worker, updates } = setup([sample()], async (event) => published.push(event));

  await worker.flush();

  assert.equal(published.length, 1);
  assert.deepEqual(published[0], {
    event_id: '11111111-1111-4111-8111-111111111111',
    event_type: 'payment.authorized',
    source_service: 'payment-service',
    entity_id: '22222222-2222-4222-8222-222222222222',
    entity_version: 1,
    schema_version: 1,
    occurred_at: '2026-10-17T12:00:00.000Z',
    correlation_id: '33333333-3333-4333-8333-333333333333',
    payload: { payment_id: '22222222-2222-4222-8222-222222222222', amount: '1200.00' },
  });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, sample().id);
  assert.ok(updates[0].data.publishedAt instanceof Date);
  assert.deepEqual(updates[0].data.attempts, { increment: 1 });
  assert.equal(updates[0].data.lastError, null);
  assert.equal(updates[0].data.lockedUntil, null);
});

test('registra el error y programa reintento cuando RabbitMQ falla', async () => {
  const { worker, updates } = setup([sample()], async () => { throw new Error('broker desconectado'); });
  const before = Date.now();

  await worker.flush();

  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.lastError, 'broker desconectado');
  assert.equal(updates[0].data.publishedAt, undefined);
  assert.ok(updates[0].data.availableAt.getTime() >= before + 900);
  assert.equal(updates[0].data.lockedUntil, null);
});

test('no consulta ni publica si RabbitMQ no está conectado', async () => {
  const { worker, db, updates } = setup();
  let queries = 0;
  db.$queryRaw = async () => { queries += 1; return [sample()]; };
  worker['events'].isConnected = () => false;

  await worker.flush();

  assert.equal(queries, 0);
  assert.equal(updates.length, 0);
});

test('evita dos ejecuciones concurrentes del worker en una misma réplica', async () => {
  let releasePublish;
  let publishCount = 0;
  const pendingPublish = new Promise((resolve) => { releasePublish = resolve; });
  const { worker } = setup([sample()], async () => { publishCount += 1; await pendingPublish; });

  const first = worker.flush();
  await worker.flush();
  assert.equal(publishCount, 1);
  releasePublish();
  await first;
  assert.equal(publishCount, 1);
});
