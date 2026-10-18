const assert = require('node:assert/strict');
const { test } = require('node:test');
const { connect } = require('amqp-connection-manager');
const { EventsService } = require('../dist/events.service.js');

const url = process.env.RABBITMQ_URL;
const exchange = process.env.RABBITMQ_EXCHANGE || 'farmtotable.events';

test('publica y confirma un evento en RabbitMQ real', { skip: !url && 'Define RABBITMQ_URL para ejecutar integración' }, async (t) => {
  const consumer = connect([url]);
  const publisher = new EventsService({ get: (key) => key === 'RABBITMQ_URL' ? url : exchange });
  let resolveMessage;
  let rejectMessage;
  const received = new Promise((resolve, reject) => { resolveMessage = resolve; rejectMessage = reject; });
  const timer = setTimeout(() => rejectMessage(new Error('RabbitMQ no entregó el mensaje a tiempo')), 5000);
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
    consumer.on('connect', () => {});
    consumer.on('disconnect', ({ err }) => reject(err));
  });

  t.after(async () => {
    clearTimeout(timer);
    await publisher.onApplicationShutdown();
    await consumer.close();
  });

  publisher.onModuleInit();
  await Promise.all([ready, waitUntilConnected(publisher)]);

  const expected = {
    event_id: '11111111-1111-4111-8111-111111111111',
    event_type: 'payment.integration',
    source_service: 'payment-service',
    entity_id: '22222222-2222-4222-8222-222222222222',
    entity_version: 1,
    schema_version: 1,
    occurred_at: '2026-10-17T12:00:00.000Z',
    correlation_id: '33333333-3333-4333-8333-333333333333',
    payload: { amount: '1200.00' },
  };

  await publisher.publish(expected);
  assert.deepEqual(await received, expected);
});

async function waitUntilConnected(service) {
  const deadline = Date.now() + 5000;
  while (!service.isConnected() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(service.isConnected(), true, 'EventsService no conectó con RabbitMQ');
}
