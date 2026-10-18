import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const container = `ftt-analytics-rebuild-e2e-${suffix}`;
const user = 'ftt_analytics_test';
const password = 'ftt_analytics_local_only';
const database = 'analytics_e2e';
const databaseUrl = `postgresql://${user}:${password}@127.0.0.1:`;
let port;
let prisma;
let containerStarted = false;

function run(command, args, env = process.env) {
  try { return execFileSync(command, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (error) { throw new Error(`${command} ${args.join(' ')} failed:\n${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error }); }
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port: selected } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return selected;
}

async function waitForPostgres(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { run('docker', ['exec', container, 'pg_isready', '-U', user, '-d', database]); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  throw new Error('PostgreSQL temporal no quedó listo');
}

function archivedEvent({ eventId, eventType, sourceService, entityId, payload, occurredAt = new Date('2026-10-17T19:20:00.000Z') }) {
  return { eventId, eventType, sourceService, entityId, entityVersion: 1, schemaVersion: 1, occurredAt, processedAt: new Date(), correlationId, payload, periodId };
}

const periodId = '4b23040a-91f5-46e8-a7d1-016a67c889c8';
const orderId = 'c9ac31a8-326d-4fc0-9ef8-3e87f4358c39';
const buyerId = '868c57d1-31be-485e-a15b-634c500aa564';
const producerId = 'b0b761e6-1b8e-4e9c-9132-76899a67ef74';
const productId = '32bbe7ad-6a53-4dd6-944d-e1720bbfb52c';
const itemId = 'be42b2ec-d083-45ce-a264-2a92564ec650';
const paymentId = '3e84633e-8122-40ec-8e8c-225bfa311f29';
const correlationId = '3243494e-46a8-4700-a469-b8c92e0554b4';

try {
  port = await freePort();
  run('docker', ['run', '--rm', '-d', '--name', container, '-p', `127.0.0.1:${port}:5432`, '-e', `POSTGRES_USER=${user}`, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${database}`, 'postgres:16-alpine']);
  containerStarted = true;
  await waitForPostgres();

  const url = `${databaseUrl}${port}/${database}?schema=public`;
  const safeEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'test', DATABASE_URL: url, DIRECT_URL: url };
  const serviceDir = path.join(root, 'analytics-service');
  run(process.execPath, [path.join(serviceDir, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy', '--schema', path.join(serviceDir, 'prisma', 'schema.prisma')], safeEnv);

  const requireFromService = createRequire(path.join(serviceDir, 'package.json'));
  const { PrismaClient } = requireFromService('@prisma/client');
  const { AnalyticsService } = await import(pathToFileURL(path.join(serviceDir, 'dist', 'analytics.service.js')).href);
  prisma = new PrismaClient({ datasources: { db: { url } } });
  await prisma.$connect();

  await prisma.analyticsPeriod.create({ data: { id: periodId, startDate: new Date('2026-10-17T00:00:00.000Z'), endDate: new Date('2026-10-18T00:00:00.000Z') } });
  const confirmedAt = new Date('2026-10-17T19:20:00.000Z');
  await prisma.processedEvent.createMany({ data: [
    archivedEvent({ eventId: '2c4547ef-6bc4-4e1b-8b6e-1eead60bad63', eventType: 'order.confirmed', sourceService: 'order-service', entityId: orderId, occurredAt: confirmedAt, payload: { orderId, buyerId, paymentId, items: [{ id: itemId, productId, producerId, productName: 'Tomate', quantity: '4.000', unitPrice: '25.00' }] } }),
    archivedEvent({ eventId: '4126d369-d5d1-4f55-ae9b-7c5c502e34a1', eventType: 'order.fulfillment_closed', sourceService: 'logistics-service', entityId: orderId, occurredAt: confirmedAt, payload: { order_id: orderId, items: [{ order_item_id: itemId, accepted_quantity_kg: '3.000', accepted_amount: '75.00' }] } }),
    archivedEvent({ eventId: 'ac8303a9-b328-4e89-afeb-b2ef2fc302e2', eventType: 'payment.captured', sourceService: 'payment-service', entityId: paymentId, occurredAt: confirmedAt, payload: { payment_id: paymentId, order_id: orderId, amount: '90.00' } }),
  ] });

  // Seed deliberately incorrect derived facts and durable report history.
  await prisma.orderFact.create({ data: { orderId, buyerId: producerId, paymentId, orderedAt: new Date('2020-01-01T00:00:00.000Z') } });
  await prisma.orderLineFact.create({ data: { orderItemId: itemId, orderId, productId, producerId, productName: 'Incorrecto', quantityKg: 99, unitPrice: 1, acceptedQuantity: 99, acceptedAmount: 99 } });
  await prisma.paymentFact.create({ data: { paymentId, orderId, amount: 1, capturedAt: new Date('2020-01-01T00:00:00.000Z') } });
  const report = await prisma.reportFact.create({ data: { reportType: 'sales', startAt: confirmedAt, endAt: new Date('2026-10-18T00:00:00.000Z'), timezone: 'UTC', result: { retained: true } } });
  const outbox = await prisma.outboxEvent.create({ data: { eventType: 'report.generated', aggregateId: report.id, correlationId, payload: { report_id: report.id } } });

  const analytics = new AnalyticsService(prisma);
  const rebuilt = await analytics.rebuildProjections('REBUILD_ANALYTICS_PROJECTIONS');
  assert.equal(rebuilt.events_replayed, 3);
  const line = await prisma.orderLineFact.findUniqueOrThrow({ where: { orderItemId: itemId } });
  assert.equal(line.productName, 'Tomate');
  assert.equal(Number(line.quantityKg), 4);
  assert.equal(Number(line.acceptedQuantity), 3);
  assert.equal(Number(line.acceptedAmount), 75);
  assert.equal(Number((await prisma.paymentFact.findUniqueOrThrow({ where: { paymentId } })).amount), 90);
  assert.equal(await prisma.processedEvent.count(), 3, 'el archivo de eventos se conserva');
  assert.equal(await prisma.reportFact.count(), 1, 'los informes históricos se conservan');
  assert.equal(await prisma.outboxEvent.count({ where: { id: outbox.id, publishedAt: null } }), 1, 'el outbox no se borra durante la reconstrucción');
  const sales = await analytics.sales({ start: '2026-10-17', end: '2026-10-18', timezone: 'UTC' });
  assert.equal(sales.captured_cop, 90);
  assert.equal(sales.unallocated_cop, 15);
  assert.equal(sales.by_product[0].revenue_cop, 75);

  await analytics.rebuildProjections('REBUILD_ANALYTICS_PROJECTIONS');
  assert.equal(await prisma.orderLineFact.count(), 1, 'reconstrucciones repetidas no duplican hechos');

  await prisma.processedEvent.create({ data: archivedEvent({ eventId: '9023e8de-2a56-489c-a47a-07b1e8991e18', eventType: 'product.updated', sourceService: 'catalog-service', entityId: productId, occurredAt: confirmedAt, payload: { product_id: productId, name: '' } }) });
  await assert.rejects(analytics.rebuildProjections('REBUILD_ANALYTICS_PROJECTIONS'));
  assert.equal(await prisma.orderFact.count(), 1, 'un fallo de replay revierte la transacción y conserva las proyecciones anteriores');
  assert.equal(await prisma.orderLineFact.count(), 1);
  console.log('Analytics rebuild E2E passed: archived events reconstruct facts atomically, repeated rebuilds are idempotent, reports/outbox stay intact, and invalid history rolls back safely.');
} finally {
  await prisma?.$disconnect().catch(() => undefined);
  if (containerStarted) {
    try { run('docker', ['rm', '-f', container]); } catch { /* container may already have exited */ }
  }
}
