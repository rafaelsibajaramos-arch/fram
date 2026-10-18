import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const pgContainer = `ftt-rating-pg-${suffix}`;
const rabbitContainer = `ftt-rating-rabbit-${suffix}`;
const pgUser = 'ftt_rating_test';
const pgPassword = 'ftt_rating_local_only';
const orderDb = 'orders_rating_e2e';
const analyticsDb = 'analytics_rating_e2e';
const buyerId = randomUUID();
const orderId = randomUUID();
const productId = randomUUID();
const correlationId = randomUUID();
const score = 5;
const comment = 'Entrega excelente y producto fresco';
let pgPort; let rabbitPort; let orderPort; let analyticsPort;
let pgStarted = false; let rabbitStarted = false;
let orderPrisma; let analyticsPrisma; let orderProcess; let analyticsProcess;
let orderLog = ''; let analyticsLog = '';

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

async function waitFor(label, check, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* service/container starting */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`${label} no quedó listo a tiempo`);
}

function token(privateKey, roles = ['buyer']) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ sub: buyerId, roles, iss: 'farmtotable-identity', aud: 'farmtotable-api', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 })}`;
  const signer = createSign('RSA-SHA256'); signer.update(input); signer.end();
  return `${input}.${signer.sign(privateKey).toString('base64url')}`;
}

function startService(serviceDir, env, onLog) {
  const child = spawn(process.execPath, [path.join(serviceDir, 'dist', 'main.js')], { cwd: serviceDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => onLog(chunk));
  child.stderr.on('data', (chunk) => onLog(chunk));
  return child;
}

async function ready(url, processRef, logRef, serviceName) {
  await waitFor(`${serviceName} readiness`, async () => {
    if (processRef().exitCode != null) throw new Error(`${serviceName} terminated:\n${logRef()}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return response.ok;
  });
}

async function stop(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 4000))]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

try {
  [pgPort, rabbitPort, orderPort, analyticsPort] = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  run('docker', ['run', '--rm', '-d', '--name', pgContainer, '-p', `127.0.0.1:${pgPort}:5432`, '-e', `POSTGRES_USER=${pgUser}`, '-e', `POSTGRES_PASSWORD=${pgPassword}`, '-e', `POSTGRES_DB=${orderDb}`, 'postgres:16-alpine']);
  pgStarted = true;
  run('docker', ['run', '--rm', '-d', '--name', rabbitContainer, '-p', `127.0.0.1:${rabbitPort}:5672`, '-e', 'RABBITMQ_DEFAULT_USER=ftt_rating_test', '-e', 'RABBITMQ_DEFAULT_PASS=ftt_rating_local_only', 'rabbitmq:3.13-alpine']);
  rabbitStarted = true;
  await waitFor('PostgreSQL temporal', () => { run('docker', ['exec', pgContainer, 'pg_isready', '-U', pgUser, '-d', orderDb]); return true; });
  await waitFor('RabbitMQ temporal', () => { run('docker', ['exec', rabbitContainer, 'rabbitmq-diagnostics', '-q', 'ping']); return true; });
  run('docker', ['exec', pgContainer, 'createdb', '-U', pgUser, analyticsDb]);

  const orderUrl = `postgresql://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${orderDb}?schema=public`;
  const analyticsUrl = `postgresql://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${analyticsDb}?schema=public`;
  const rabbitUrl = `amqp://ftt_rating_test:ftt_rating_local_only@127.0.0.1:${rabbitPort}`;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const commonEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'development', JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }).toString(), JWT_ISSUER: 'farmtotable-identity', JWT_AUDIENCE: 'farmtotable-api', RABBITMQ_URL: rabbitUrl, RABBITMQ_EXCHANGE: 'farmtotable.events' };
  const orderDir = path.join(root, 'order-service');
  const analyticsDir = path.join(root, 'analytics-service');
  const orderEnv = { ...commonEnv, PORT: String(orderPort), DATABASE_URL: orderUrl, DIRECT_URL: orderUrl, OUTBOX_POLL_MS: '500' };
  const analyticsEnv = { ...commonEnv, PORT: String(analyticsPort), DATABASE_URL: analyticsUrl, DIRECT_URL: analyticsUrl };
  for (const [serviceDir, env] of [[orderDir, orderEnv], [analyticsDir, analyticsEnv]]) {
    run(process.execPath, [path.join(serviceDir, 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy', '--schema', path.join(serviceDir, 'prisma', 'schema.prisma')], env);
  }

  const orderRequire = createRequire(path.join(orderDir, 'package.json'));
  const analyticsRequire = createRequire(path.join(analyticsDir, 'package.json'));
  orderPrisma = new (orderRequire('@prisma/client').PrismaClient)({ datasources: { db: { url: orderUrl } } });
  analyticsPrisma = new (analyticsRequire('@prisma/client').PrismaClient)({ datasources: { db: { url: analyticsUrl } } });
  await Promise.all([orderPrisma.$connect(), analyticsPrisma.$connect()]);
  await orderPrisma.order.create({ data: { id: orderId, buyerId, status: 'delivered', paymentStatus: 'captured', totalAmount: 75, currency: 'COP', deliveryAddress: 'Finca de prueba', items: { create: { productId, productName: 'Tomate', quantity: 3, unitPrice: 25, subtotal: 75, acceptedQuantity: 3, acceptedSubtotal: 75 } } } });

  orderProcess = startService(orderDir, orderEnv, (chunk) => { orderLog = `${orderLog}${chunk}`.slice(-12_000); });
  analyticsProcess = startService(analyticsDir, analyticsEnv, (chunk) => { analyticsLog = `${analyticsLog}${chunk}`.slice(-12_000); });
  await Promise.all([
    ready(`http://127.0.0.1:${orderPort}/api/v1/health/ready`, () => orderProcess, () => orderLog, 'order-service'),
    ready(`http://127.0.0.1:${analyticsPort}/api/v1/health/ready`, () => analyticsProcess, () => analyticsLog, 'analytics-service'),
  ]);

  const jwt = token(privateKey);
  const ratingResponse = await fetch(`http://127.0.0.1:${orderPort}/api/v1/orders/${orderId}/rating`, { method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', 'x-correlation-id': correlationId }, body: JSON.stringify({ score, comment }) });
  const responseText = await ratingResponse.text();
  assert.equal(ratingResponse.status, 201, responseText);
  const responseBody = JSON.parse(responseText);
  assert.equal(responseBody.replayed, false);
  const ratingId = responseBody.rating.id;
  const duplicate = await fetch(`http://127.0.0.1:${orderPort}/api/v1/orders/${orderId}/rating`, { method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }, body: JSON.stringify({ score, comment }) });
  assert.equal(duplicate.status, 201);
  assert.equal((await duplicate.json()).replayed, true, 'repetir la misma calificación no crea otra');
  assert.equal(await orderPrisma.orderRating.count({ where: { orderId } }), 1);
  assert.equal(await orderPrisma.outboxEvent.count({ where: { eventType: 'rating.created', aggregateId: ratingId } }), 1);

  await waitFor('evento publicado por outbox de Pedidos', async () => (await orderPrisma.outboxEvent.findFirst({ where: { eventType: 'rating.created', aggregateId: ratingId } }))?.status === 'published', 20_000);
  await waitFor('proyección de calificación en Analytics', () => analyticsPrisma.ratingFact.findUnique({ where: { ratingId } }), 20_000);
  const projection = await analyticsPrisma.ratingFact.findUniqueOrThrow({ where: { ratingId } });
  assert.equal(projection.orderId, orderId);
  assert.equal(projection.buyerId, buyerId);
  assert.equal(projection.score, score);
  assert.equal(projection.comment, comment);
  assert.equal(await analyticsPrisma.processedEvent.count({ where: { eventType: 'rating.created', entityId: ratingId } }), 1, 'Analytics registra un único evento en su inbox');

  const buyerReport = await fetch(`http://127.0.0.1:${analyticsPort}/api/v1/analytics/satisfaction?start=2026-10-01&end=2026-10-31&timezone=UTC`, { headers: { authorization: `Bearer ${jwt}` } });
  assert.equal(buyerReport.status, 403, 'el endpoint analítico permanece protegido para compradores');
  const reportResponse = await fetch(`http://127.0.0.1:${analyticsPort}/api/v1/analytics/satisfaction?start=2026-10-01&end=2026-10-31&timezone=UTC`, { headers: { authorization: `Bearer ${token(privateKey, ['admin'])}` } });
  const reportText = await reportResponse.text();
  assert.equal(reportResponse.status, 200, reportText);
  const satisfaction = JSON.parse(reportText);
  assert.equal(satisfaction.rating_count, 1);
  assert.equal(satisfaction.average_score, score);
  console.log('Order → RabbitMQ → Analytics rating E2E passed: rating endpoint, transactional outbox, event inbox, idempotent replay, and rating projection all verified on isolated services/databases.');
} catch (error) {
  console.error(error);
  if (orderLog) console.error(`order-service logs:\n${orderLog}`);
  if (analyticsLog) console.error(`analytics-service logs:\n${analyticsLog}`);
  process.exitCode = 1;
} finally {
  await Promise.all([orderPrisma?.$disconnect().catch(() => undefined), analyticsPrisma?.$disconnect().catch(() => undefined)]);
  await Promise.all([stop(orderProcess), stop(analyticsProcess)]);
  if (rabbitStarted) { try { run('docker', ['rm', '-f', rabbitContainer]); } catch { /* already removed */ } }
  if (pgStarted) { try { run('docker', ['rm', '-f', pgContainer]); } catch { /* already removed */ } }
}
