import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const postgresContainer = `ftt-notifications-pg-${suffix}`;
const rabbitContainer = `ftt-notifications-rabbit-${suffix}`;
const postgresUser = 'ftt_notifications_test';
const postgresPassword = 'ftt_notifications_local_only';
const database = 'notifications_e2e';
const internalKey = `ftt-e2e-${suffix}`;
const buyerId = '868c57d1-31be-485e-a15b-634c500aa564';
const driverId = '968c57d1-31be-485e-a15b-634c500aa565';
const producerId = 'b0b761e6-1b8e-4e9c-9132-76899a67ef74';
const producerUserId = 'a0b761e6-1b8e-4e9c-9132-76899a67ef75';
const deliveryId = '32bbe7ad-6a53-4dd6-944d-e1720bbfb52c';
const payoutId = '42bbe7ad-6a53-4dd6-944d-e1720bbfb52d';
const ratingId = '52bbe7ad-6a53-4dd6-944d-e1720bbfb52f';
const correlationId = '3243494e-46a8-4700-a469-b8c92e0554b4';
const serviceDir = path.join(root, 'notification-service');
let pgPort;
let rabbitPort;
let appPort;
let postgresStarted = false;
let rabbitStarted = false;
let prisma;
let appProcess;
let producerServer;
let appLog = '';

function run(command, args, env = process.env) {
  try { return execFileSync(command, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new Error(`${command} ${args.join(' ')} failed:\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error }); }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForContainer(command, args, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { run(command, args); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  throw new Error(`${label} no quedÃ³ listo en el tiempo esperado`);
}

async function waitFor(label, check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (check()) return; } catch { /* service/container starting */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${label} no quedó listo en el tiempo esperado`);
}

async function waitForService(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (appProcess?.exitCode != null) throw new Error(`notification-service terminÃ³ (${appProcess.exitCode}):\n${appLog}`);
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/api/v1/health/ready`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch { /* esperando que arranque */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`notification-service no quedÃ³ listo:\n${appLog}`);
}

async function waitForNotifications(expectedCount, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await prisma.notification.count();
    if (count >= expectedCount) return;
    if (appProcess?.exitCode != null) throw new Error(`notification-service terminÃ³ durante el consumo:\n${appLog}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Se esperaban ${expectedCount} notificaciones; hay ${await prisma.notification.count()}. Logs:\n${appLog}`);
}

function envelope(eventId, eventType, entityId, payload, sourceService) {
  return { event_id: eventId, event_type: eventType, source_service: sourceService, entity_id: entityId, entity_version: 1, schema_version: 1, occurred_at: new Date().toISOString(), correlation_id: correlationId, payload };
}

async function publishEvents(events) {
  const amqp = createRequire(path.join(serviceDir, 'package.json'))('amqplib');
  const connection = await amqp.connect(`amqp://ftt_notifications_test:ftt_notifications_local_only@127.0.0.1:${rabbitPort}`);
  try {
    const channel = await connection.createConfirmChannel();
    await channel.assertExchange('farmtotable.events', 'topic', { durable: true });
    for (const event of events) channel.publish('farmtotable.events', event.event_type, Buffer.from(JSON.stringify(event)), { persistent: true, contentType: 'application/json', messageId: event.event_id, type: event.event_type, correlationId: event.correlation_id });
    await channel.waitForConfirms();
    await channel.close();
  } finally { await connection.close(); }
}

try {
  pgPort = await freePort();
  rabbitPort = await freePort();
  appPort = await freePort();

  run('docker', ['run', '--rm', '-d', '--name', postgresContainer, '-p', `127.0.0.1:${pgPort}:5432`, '-e', `POSTGRES_USER=${postgresUser}`, '-e', `POSTGRES_PASSWORD=${postgresPassword}`, '-e', `POSTGRES_DB=${database}`, 'postgres:16-alpine']);
  postgresStarted = true;
  run('docker', ['run', '--rm', '-d', '--name', rabbitContainer, '-p', `127.0.0.1:${rabbitPort}:5672`, '-e', 'RABBITMQ_DEFAULT_USER=ftt_notifications_test', '-e', 'RABBITMQ_DEFAULT_PASS=ftt_notifications_local_only', 'rabbitmq:3.13-alpine']);
  rabbitStarted = true;

  await waitForContainer('docker', ['exec', postgresContainer, 'pg_isready', '-U', postgresUser, '-d', database], 'PostgreSQL temporal');
  await waitForContainer('docker', ['exec', rabbitContainer, 'rabbitmq-diagnostics', '-q', 'ping'], 'RabbitMQ temporal');

  const url = `postgresql://${postgresUser}:${postgresPassword}@127.0.0.1:${pgPort}/${database}?schema=public`;
  const rabbitUrl = `amqp://ftt_notifications_test:ftt_notifications_local_only@127.0.0.1:${rabbitPort}`;
  const appEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: 'test',
    PORT: String(appPort),
    DATABASE_URL: url,
    DIRECT_URL: url,
    JWT_PUBLIC_KEY: 'not-used-by-health-or-consumer-e2e',
    JWT_ISSUER: 'farmtotable-identity',
    JWT_AUDIENCE: 'farmtotable-api',
    INTERNAL_API_KEY: internalKey,
    IDENTITY_SERVICE_URL: 'http://127.0.0.1:1',
    PRODUCER_SERVICE_URL: 'http://127.0.0.1:1',
    RABBITMQ_URL: rabbitUrl,
    RABBITMQ_EXCHANGE: 'farmtotable.events',
  };
  run(process.execPath, [path.join(serviceDir, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy', '--schema', path.join(serviceDir, 'prisma', 'schema.prisma')], appEnv);

  producerServer = http.createServer((req, res) => {
    if (req.url !== `/internal/producers/${producerId}/user` || req.headers['x-internal-api-key'] !== internalKey) {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"message":"unauthorized"}'); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ user_id: producerUserId }));
  });
  await new Promise((resolve, reject) => producerServer.listen(0, '127.0.0.1', resolve).once('error', reject));
  appEnv.PRODUCER_SERVICE_URL = `http://127.0.0.1:${producerServer.address().port}`;

  const requireFromService = createRequire(path.join(serviceDir, 'package.json'));
  const { PrismaClient } = requireFromService('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();

  appProcess = spawn(process.execPath, [path.join(serviceDir, 'dist', 'main.js')], { cwd: serviceDir, env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  appProcess.stdout.on('data', (chunk) => { appLog = `${appLog}${chunk}`.slice(-12_000); });
  appProcess.stderr.on('data', (chunk) => { appLog = `${appLog}${chunk}`.slice(-12_000); });
  await waitForService();
  await waitFor('binding rating.created en RabbitMQ', () => {
    const bindings = run('docker', ['exec', rabbitContainer, 'rabbitmqctl', 'list_bindings', '-q', 'source_name', 'destination_name', 'routing_key']);
    return bindings.includes('farmtotable.notifications') && bindings.includes('rating.created');
  });

  const deliveryEvent = envelope('aa2d613f-80ec-4de9-ae20-f4dd828b3a26', 'delivery.scheduled', deliveryId, { buyer_id: buyerId, driver_user_id: driverId, order_id: '52bbe7ad-6a53-4dd6-944d-e1720bbfb52e' }, 'logistics-service');
  const payoutEvent = envelope('ba2d613f-80ec-4de9-ae20-f4dd828b3a27', 'payout.scheduled', payoutId, { producer_id: producerId, payout_id: payoutId, net_amount: '900.00' }, 'payment-service');
  const ratingEvent = envelope('ca2d613f-80ec-4de9-ae20-f4dd828b3a28', 'rating.created', ratingId, { rating_id: ratingId, order_id: '62bbe7ad-6a53-4dd6-944d-e1720bbfb52f', buyer_id: buyerId, score: 5 }, 'order-service');
  await publishEvents([deliveryEvent, payoutEvent, ratingEvent]);
  await waitForNotifications(4);

  const rows = await prisma.notification.findMany({ orderBy: [{ type: 'asc' }, { userId: 'asc' }] });
  assert.deepEqual(rows.map(({ type, userId, channel, status }) => ({ type, userId, channel, status })), [
    { type: 'delivery.scheduled', userId: buyerId, channel: 'in_app', status: 'sent' },
    { type: 'delivery.scheduled', userId: driverId, channel: 'in_app', status: 'sent' },
    { type: 'payout.scheduled', userId: producerUserId, channel: 'in_app', status: 'sent' },
    { type: 'rating.created', userId: buyerId, channel: 'in_app', status: 'sent' },
  ]);
  await publishEvents([deliveryEvent, payoutEvent, ratingEvent]);
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(await prisma.notification.count(), 4, 'reentrega de RabbitMQ no duplica notificaciones');
  assert.equal(await prisma.processedEvent.count(), 3, 'la inbox conserva un solo registro por evento');
  assert.equal(await prisma.outboxEvent.count({ where: { eventType: 'notification.sent' } }), 4, 'cada aviso in-app crea su evento outbox');
  console.log('Notifications E2E passed: real RabbitMQ consumer persisted buyer, driver, producer and order-rating notifications in isolated PostgreSQL; replay stayed idempotent and in-app outbox records were written.');
} finally {
  await prisma?.$disconnect().catch(() => undefined);
  if (appProcess && appProcess.exitCode == null) {
    appProcess.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => appProcess.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (appProcess.exitCode == null) appProcess.kill('SIGKILL');
  }
  if (producerServer?.listening) await new Promise((resolve) => producerServer.close(resolve));
  if (rabbitStarted) { try { run('docker', ['rm', '-f', rabbitContainer]); } catch { /* already removed */ } }
  if (postgresStarted) { try { run('docker', ['rm', '-f', postgresContainer]); } catch { /* already removed */ } }
}
