import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const amqp = createRequire(path.join(root, 'order-service', 'package.json'))('amqplib');
const args = parseArgs(process.argv.slice(2));
const rabbitUrl = process.env.RABBITMQ_URL;
const exchange = process.env.RABBITMQ_EXCHANGE ?? 'farmtotable.events';
const maxLimit = 1000;

if (args.help) {
  console.log('Usage: node scripts/rabbitmq-dlq-redrive.mjs --queue <consumer.queue.dead> [--limit 20] [--routing-key <fallback>] [--apply]');
  console.log('Default is a passive dry-run. --apply republishes valid messages and removes the DLQ copy only after broker confirmation.');
  process.exit(0);
}

if (!rabbitUrl) throw new Error('Missing RABBITMQ_URL; its value will not be printed.');
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,250}\.dead$/.test(args.queue ?? '')) throw new Error('--queue must be an explicitly named .dead queue.');
if (!Number.isInteger(args.limit) || args.limit <= 0 || args.limit > maxLimit) throw new Error(`--limit must be between 1 and ${maxLimit}.`);
if (args.routingKey && !/^[a-zA-Z0-9_*#.-]{1,160}$/.test(args.routingKey)) throw new Error('--routing-key has an invalid format.');

const sourceQueue = args.queue.slice(0, -'.dead'.length);
const connection = await amqp.connect(rabbitUrl);
let channel;
let completed = false;
let processed = 0;
let skipped = 0;
let returned = false;

try {
  channel = await connection.createConfirmChannel();
  channel.on('return', () => { returned = true; });
  // Passive checks only: a dry-run must not declare or mutate RabbitMQ topology.
  await channel.checkExchange(exchange);
  const deadQueue = await channel.checkQueue(args.queue);
  await channel.checkQueue(sourceQueue);
  if (!args.apply) {
    console.log(`Dry-run: DLQ=${args.queue} ready=${deadQueue.messageCount}; destination=${sourceQueue}; exchange=${exchange}; limit=${args.limit}. No changes.`);
    completed = true;
  } else {
    console.warn(`Redrive active: DLQ=${args.queue}, destination=${sourceQueue}, exchange=${exchange}, limit=${args.limit}.`);
    for (let index = 0; index < args.limit; index++) {
      const message = await channel.get(args.queue, { noAck: false });
      if (!message) break;
      const envelope = parseEnvelope(message.content);
      const routingKey = originalRoutingKey(message.properties.headers, sourceQueue, exchange, envelope, args.routingKey);
      if (!envelope || !routingKey) {
        channel.nack(message, false, true);
        skipped++;
        console.error(`Invalid message or original route unavailable; kept in ${args.queue}. messageId=${safeId(message.properties.messageId)}`);
        break;
      }

      try {
        returned = false;
        channel.publish(exchange, routingKey, message.content, { ...redriveProperties(message.properties), mandatory: true });
        await channel.waitForConfirms();
        if (returned) throw new Error('RabbitMQ did not find a queue bound to the target route.');
      } catch (error) {
        channel.nack(message, false, true);
        throw new Error(`Republish was not confirmed; original remains in DLQ: ${error.message}`);
      }
      channel.ack(message);
      processed++;
      console.log(`Republished messageId=${safeId(message.properties.messageId ?? envelope.event_id)} routingKey=${routingKey}`);
    }
    const remaining = await channel.checkQueue(args.queue);
    const sourceAfter = await channel.checkQueue(sourceQueue);
    console.log(`Redrive complete: republished=${processed}, kept=${skipped}, DLQ_remaining=${remaining.messageCount}, source_ready=${sourceAfter.messageCount}.`);
    completed = true;
  }
} finally {
  await channel?.close().catch(() => undefined);
  await connection.close().catch(() => undefined);
}

if (!completed) process.exitCode = 1;

function parseArgs(values) {
  const parsed = { limit: 20, apply: false, help: false };
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--apply') parsed.apply = true;
    else if (value === '--help' || value === '-h') parsed.help = true;
    else if (value === '--queue') parsed.queue = values[++index];
    else if (value === '--limit') parsed.limit = Number(values[++index]);
    else if (value === '--routing-key') parsed.routingKey = values[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

function parseEnvelope(content) {
  let envelope;
  try { envelope = JSON.parse(content.toString()); } catch { return null; }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  if (!isUuid(envelope.event_id) || !isUuid(envelope.entity_id)) return null;
  if (typeof envelope.event_type !== 'string' || !/^[a-z][a-z0-9_.-]{1,119}$/.test(envelope.event_type)) return null;
  if (typeof envelope.source_service !== 'string' || envelope.source_service.length > 80) return null;
  if (!Number.isInteger(envelope.entity_version) || !Number.isInteger(envelope.schema_version)) return null;
  if (typeof envelope.occurred_at !== 'string' || !Number.isFinite(Date.parse(envelope.occurred_at))) return null;
  if (typeof envelope.correlation_id !== 'string' || !envelope.correlation_id.length || envelope.correlation_id.length > 180) return null;
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) return null;
  return envelope;
}

function originalRoutingKey(headers, queue, expectedExchange, envelope, override) {
  const deaths = Array.isArray(headers?.['x-death']) ? headers['x-death'] : [];
  for (const death of deaths) {
    if (death?.queue !== queue || death?.exchange !== expectedExchange) continue;
    const keys = death['routing-keys'];
    const key = Array.isArray(keys) ? keys.find((candidate) => typeof candidate === 'string') : undefined;
    if (key && (!override || override === key)) return key;
    return null;
  }
  // A manual fallback is restricted to the event's own type to prevent fan-out.
  return override && override === envelope?.event_type ? override : null;
}

function redriveProperties(properties) {
  const headers = Object.fromEntries(Object.entries(properties.headers ?? {}).filter(([key]) => {
    const lower = key.toLowerCase();
    return lower !== 'x-death' && !lower.startsWith('x-first-death-') && !lower.startsWith('x-last-death-');
  }));
  return {
    contentType: properties.contentType,
    contentEncoding: properties.contentEncoding,
    headers,
    deliveryMode: 2,
    priority: properties.priority,
    correlationId: properties.correlationId,
    replyTo: properties.replyTo,
    messageId: properties.messageId,
    timestamp: properties.timestamp,
    type: properties.type,
    appId: properties.appId,
  };
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeId(value) {
  return typeof value === 'string' && value.length <= 180 ? value : 'no-id';
}
