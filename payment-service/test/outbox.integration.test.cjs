const assert = require('node:assert/strict');
const { test } = require('node:test');
const { connect } = require('amqp-connection-manager');
const { EventsService } = require('../dist/events.service.js');
const { OutboxWorker } = require('../dist/outbox.worker.js');
const { PrismaService } = require('../dist/prisma.service.js');

const url = process.env.RABBITMQ_URL;
const exchange = process.env.RABBITMQ_EXCHANGE || 'farmtotable.events';
const databaseConfigured = Boolean(process.env.DATABASE_URL);

test('entrega un evento persistido por el outbox a RabbitMQ y lo marca publicado', {
  skip: !(url && databaseConfigured) && 'Define DATABASE_URL local y RABBITMQ_URL para ejecutar integración',
}, async (t) => {
  const prisma = new PrismaService();
  const consumer = connect([url]);
  const publisher = new EventsService({ get: (key) => key === 'RABBITMQ_URL' ? url : exchange });
  let row;
  let resolveMessage;
  let rejectMessage;
  const received = new Promise((resolve, reject) => { resolveMessage = resolve; rejectMessage = reject; });
  const timer = setTimeout(() => rejectMessage(new Error('El evento del outbox no llegó a RabbitMQ')), 5000);
  const ready = new Promise((resolve, reject) => {
    const channel = consumer.createChannel({
      setup: async (raw) => {
        await raw.assertExchange(exchange, 'topic', { durable: true });
        const queue = await raw.assertQueue('', { exclusive: true, autoDelete: true });
        await raw.bindQueue(queue.queue, exchange, 'payment.integration');
        await raw.consume(queue.queue, (message) => {
          if (!message) return;
          raw.ack(message);
          resolveMessage(JSON.parse(message.content.toString('utf8')));
        });
        resolve(channel);
      },
    });
    consumer.on('disconnect', ({ err }) => reject(err));
  });

  t.after(async () => {
    clearTimeout(timer);
    if (row) await prisma.outboxEvent.deleteMany({ where: { id: row.id } });
    await publisher.onApplicationShutdown();
    await consumer.close();
    await prisma.$disconnect();
  });

  await prisma.$connect();
  publisher.onModuleInit();
  await Promise.all([ready, waitUntilConnected(publisher)]);
  row = await prisma.outboxEvent.create({
    data: {
      eventType: 'payment.integration',
      aggregateId: '22222222-2222-4222-8222-222222222222',
      correlationId: '33333333-3333-4333-8333-333333333333',
      payload: { amount: '1200.00' },
    },
  });

  await new OutboxWorker(prisma, publisher).flush();

  const message = await received;
  assert.equal(message.event_id, row.id);
  assert.equal(message.event_type, 'payment.integration');
  assert.equal(message.source_service, 'payment-service');
  assert.equal(message.entity_id, row.aggregateId);
  assert.equal(message.correlation_id, row.correlationId);
  assert.deepEqual(message.payload, { amount: '1200.00' });

  const delivered = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: row.id } });
  assert.ok(delivered.publishedAt instanceof Date);
  assert.equal(delivered.attempts, 1);
  assert.equal(delivered.lockedUntil, null);
});

async function waitUntilConnected(service) {
  const deadline = Date.now() + 5000;
  while (!service.isConnected() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(service.isConnected(), true, 'EventsService no conectó con RabbitMQ');
}
