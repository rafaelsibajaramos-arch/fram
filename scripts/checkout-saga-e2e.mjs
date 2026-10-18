import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

// Despliega solo contenedores con nombres ftt-checkout-e2e-* y usa puertos
// efímeros. Nunca consulta ni toma valores de .env.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const containers = [];
const children = [];
const clients = [];
const serviceProcesses = new Map();
const logs = new Map();
const amqp = createRequire(path.join(root, 'order-service', 'package.json'))('amqplib');
const dbUser = 'ftt_e2e';
const dbPassword = 'ftt_e2e_local_only';
const rabbitUser = 'ftt_e2e';
const rabbitPassword = 'ftt_e2e_local_only';
const internalApiKey = `ftt-e2e-${suffix}`;
const buyerId = '10000000-0000-4000-8000-000000000001';
const responseLostBuyerId = '10000000-0000-4000-8000-000000000007';
const logisticsCrashBuyerId = '10000000-0000-4000-8000-000000000009';
const lowBalanceBuyerId = '10000000-0000-4000-8000-000000000002';
const partialBuyerId = '10000000-0000-4000-8000-000000000003';
const failedDeliveryBuyerId = '10000000-0000-4000-8000-000000000004';
const multiLineRaceBuyerIds = ['10000000-0000-4000-8000-000000000010', '10000000-0000-4000-8000-000000000011'];
const producerId = '20000000-0000-4000-8000-000000000001';
const producerUserId = '20000000-0000-4000-8000-000000000002';
const unrelatedProducerId = '20000000-0000-4000-8000-000000000003';
const productIds = ['30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002', '30000000-0000-4000-8000-000000000003', '30000000-0000-4000-8000-000000000004'];
const exchange = 'farmtotable.checkout.e2e';
const testJwtKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function testJwt(subject, roles) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    sub: subject, sid: `e2e-${subject}`, roles, roles_version: 0,
    iss: 'farmtotable-identity', aud: 'farmtotable-api', iat: now, exp: now + 300,
  })}`;
  return `${unsigned}.${signBytes('RSA-SHA256', Buffer.from(unsigned), testJwtKeys.privateKey).toString('base64url')}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} falló:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return (result.stdout ?? '').trim();
}

function localEnvironment(overrides = {}) {
  const env = {};
  for (const wanted of ['path', 'systemroot', 'temp', 'tmp']) {
    const key = Object.keys(process.env).find((candidate) => candidate.toLowerCase() === wanted);
    if (key) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForPort(port, label, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', resolve);
        socket.setTimeout(500);
        socket.once('timeout', () => socket.destroy(new Error('timeout')));
        socket.once('error', reject);
        socket.once('connect', () => socket.end());
      });
      return;
    } catch { await delay(500); }
  }
  throw new Error(`Tiempo de espera agotado esperando ${label} en 127.0.0.1:${port}`);
}

async function connectRabbit(port, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    try { return await amqp.connect(`amqp://${rabbitUser}:${rabbitPassword}@127.0.0.1:${port}`); }
    catch (error) { lastError = error; await delay(500); }
  }
  throw new Error(`RabbitMQ no aceptó conexiones AMQP: ${lastError?.message ?? 'sin respuesta'}`);
}

async function openRabbitMonitor() {
  rabbitMonitor = await connectRabbit(rabbitPort);
  rabbitMonitorChannel = await rabbitMonitor.createConfirmChannel();
  await rabbitMonitorChannel.assertExchange(exchange, 'topic', { durable: true });
}

async function startContainer(name, image, port, args) {
  run('docker', ['run', '--rm', '-d', '--name', name, '-p', `127.0.0.1:${port}:${image.startsWith('postgres') ? '5432' : '5672'}`, ...args, image]);
  containers.push(name);
  await waitForPort(port, name);
}

async function waitForPostgres(containerName, databaseName) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      run('docker', ['exec', containerName, 'pg_isready', '-U', dbUser, '-d', databaseName]);
      return;
    } catch { await delay(500); }
  }
  throw new Error(`Postgres ${containerName} no terminó de inicializar ${databaseName}`);
}

function serviceEnvironment(databaseUrl, port, overrides = {}) {
  return {
    ...localEnvironment(),
    NODE_ENV: 'production',
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    DIRECT_URL: databaseUrl,
    RABBITMQ_URL: `amqp://${rabbitUser}:${rabbitPassword}@127.0.0.1:${rabbitPort}`,
    RABBITMQ_EXCHANGE: exchange,
    JWT_ALG: 'RS256',
    JWT_PUBLIC_KEY: testJwtKeys.publicKey,
    JWT_ISSUER: 'farmtotable-identity',
    JWT_AUDIENCE: 'farmtotable-api',
    PLATFORM_COMMISSION_RATE: '0.10',
    OUTBOX_POLL_MS: '500',
    INTERNAL_API_KEY: internalApiKey,
    ...overrides,
  };
}

async function migrate(service, databaseUrl) {
  const serviceDir = path.join(root, service);
  const prismaCli = path.join(serviceDir, 'node_modules', 'prisma', 'build', 'index.js');
  run(process.execPath, [prismaCli, 'migrate', 'deploy', '--schema', path.join(serviceDir, 'prisma', 'schema.prisma')], {
    cwd: serviceDir,
    env: localEnvironment({ DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl }),
  });
}

function startService(service, port, databaseUrl, overrides = {}) {
  const serviceDir = path.join(root, service);
  const entry = path.join(serviceDir, 'dist', 'main.js');
  const child = spawn(process.execPath, [entry], {
    cwd: os.tmpdir(),
    env: serviceEnvironment(databaseUrl, port, overrides),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  serviceProcesses.set(service, child);
  logs.set(service, []);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    const rows = logs.get(service);
    rows.push(String(chunk).trim());
    if (rows.length > 120) rows.shift();
  });
  child.once('exit', (code) => {
    if (code !== null && code !== 0) console.error(`${service} terminó con código ${code}`);
  });
  return child;
}

async function stopService(service) {
  const child = serviceProcesses.get(service);
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  serviceProcesses.delete(service);
}

async function crashService(service) {
  const child = serviceProcesses.get(service);
  if (!child || child.exitCode !== null) throw new Error(`No active local process to crash for ${service}`);
  child.kill('SIGKILL');
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) throw new Error(`Local process ${service} did not exit after SIGKILL`);
  serviceProcesses.delete(service);
}

async function waitForReady(url, label) {
  const until = Date.now() + 60_000;
  let lastError;
  while (Date.now() < until) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) { lastError = error; }
    await delay(500);
  }
  throw new Error(`${label} no quedó listo: ${lastError?.message ?? 'sin respuesta'}\n${[...logs].map(([name, rows]) => `--- ${name} ---\n${rows.join('\n')}`).join('\n')}`);
}

async function seedServiceClient(service, databaseUrl) {
  const serviceDir = path.join(root, service);
  const requireFromService = createRequire(path.join(serviceDir, 'package.json'));
  const { PrismaClient } = requireFromService('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  clients.push(prisma);
  await prisma.$connect();
  return prisma;
}

async function waitForOrder(orderUrl, id, headers, expectedStatus) {
  const until = Date.now() + 25_000;
  let latest;
  while (Date.now() < until) {
    const response = await fetch(`${orderUrl}/api/v1/orders/${id}`, { headers });
    if (!response.ok) throw new Error(`No se pudo consultar el pedido ${id}: HTTP ${response.status} ${await response.text()}`);
    latest = await response.json();
    if (latest.status === expectedStatus) return latest;
    if (latest.status === 'cancelled' && expectedStatus !== 'cancelled') throw new Error(`El checkout se canceló inesperadamente: ${JSON.stringify(latest)}`);
    await delay(250);
  }
  throw new Error(`El pedido no llegó a ${expectedStatus}; último estado: ${JSON.stringify(latest)}`);
}

async function requestJson(url, options, label) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(predicate, label, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < until) {
    latest = await predicate();
    if (latest) return latest;
    await delay(250);
  }
  throw new Error(`Tiempo agotado esperando ${label}; último estado: ${JSON.stringify(latest)}`);
}

let rabbitPort;
let catalogServer;
let rabbitContainerName;
let rabbitMonitor;
let rabbitMonitorChannel;
let responseDropServer;

try {
  run('docker', ['version', '--format', '{{.Server.Version}}']);
  const required = ['inventory-service', 'order-service', 'payment-service', 'logistics-service'];
  for (const service of required) {
    if (!fs.existsSync(path.join(root, service, 'dist', 'main.js')) || !fs.existsSync(path.join(root, service, 'node_modules', 'prisma', 'build', 'index.js'))) {
      throw new Error(`Faltan dependencias/build de ${service}. Ejecuta primero build y prisma generate en esos servicios.`);
    }
  }

  const pgPorts = await Promise.all(required.map(() => freePort()));
  rabbitPort = await freePort();
  const dbNames = required.map((service) => `ftt_${service.replace('-service', '')}_e2e`);
  for (let i = 0; i < required.length; i++) {
    const containerName = `ftt-checkout-e2e-${suffix}-${i}`;
    await startContainer(containerName, 'postgres:16-alpine', pgPorts[i], [
      '-e', `POSTGRES_USER=${dbUser}`, '-e', `POSTGRES_PASSWORD=${dbPassword}`, '-e', `POSTGRES_DB=${dbNames[i]}`,
    ]);
    await waitForPostgres(containerName, dbNames[i]);
  }
  rabbitContainerName = `ftt-checkout-e2e-${suffix}-rabbit`;
  await startContainer(rabbitContainerName, 'rabbitmq:3.13-management-alpine', rabbitPort, [
    '-e', `RABBITMQ_DEFAULT_USER=${rabbitUser}`, '-e', `RABBITMQ_DEFAULT_PASS=${rabbitPassword}`,
  ]);
  await openRabbitMonitor();

  const urls = pgPorts.map((port, index) => `postgresql://${dbUser}:${dbPassword}@127.0.0.1:${port}/${dbNames[index]}?schema=public`);
  for (let i = 0; i < required.length; i++) await migrate(required[i], urls[i]);

  const appPorts = await Promise.all(required.map(() => freePort()));
  for (let i = 0; i < required.length; i++) {
    const overrides = required[i] === 'logistics-service' ? { PAYMENT_SERVICE_URL: `http://127.0.0.1:${appPorts[2]}` } : {};
    startService(required[i], appPorts[i], urls[i], overrides);
  }
  const baseUrls = Object.fromEntries(required.map((service, index) => [service, `http://127.0.0.1:${appPorts[index]}`]));
  await Promise.all(required.map((service) => waitForReady(`${baseUrls[service]}${service === 'inventory-service' ? '' : '/api/v1'}/health/ready`, service)));

  const catalogPort = await freePort();
  const catalogProducts = new Map(productIds.map((id, index) => [id, {
    active: true, price: index === 0 ? 100 : 250, price_version_id: null,
    producer_id: producerId, producer_name: 'Productor de prueba',
    name: index === 0 ? 'Naranja E2E' : 'Aguacate E2E', min_order_quantity: 1,
  }]));
  catalogServer = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const producerUserMatch = pathname.match(/^\/producers\/by-user\/([^/]+)$/);
    if (producerUserMatch) {
      const producer = producerUserMatch[1] === producerUserId ? producerId : unrelatedProducerId;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: producer }));
      return;
    }
    const productId = pathname.split('/').at(-1);
    const product = catalogProducts.get(productId);
    res.writeHead(product ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(product ?? { message: 'Producto no encontrado' }));
  });
  await new Promise((resolve, reject) => catalogServer.listen(catalogPort, '127.0.0.1', resolve).once('error', reject));

  const inventory = await seedServiceClient('inventory-service', urls[0]);
  const orders = await seedServiceClient('order-service', urls[1]);
  const payments = await seedServiceClient('payment-service', urls[2]);
  const logistics = await seedServiceClient('logistics-service', urls[3]);
  const expires = new Date(); expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  const batchIds = ['40000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000003', '40000000-0000-4000-8000-000000000004'];
  for (let index = 0; index < productIds.length; index++) await inventory.inventoryItem.create({ data: {
    batchId: batchIds[index], productId: productIds[index], farmId: '50000000-0000-4000-8000-000000000001',
    pickupAddress: 'Finca E2E, Colombia', pickupLatitude: 8.75, pickupLongitude: -75.89,
    expiryEstimate: expires, physicalKg: index >= 2 ? 1 : 20, availableKg: index >= 2 ? 1 : 20,
  } });
  await payments.wallet.createMany({ data: [
    { buyerId, balance: 5000, currency: 'COP' },
    { buyerId: responseLostBuyerId, balance: 5000, currency: 'COP' },
    { buyerId: logisticsCrashBuyerId, balance: 5000, currency: 'COP' },
    { buyerId: lowBalanceBuyerId, balance: 10, currency: 'COP' },
    { buyerId: partialBuyerId, balance: 5000, currency: 'COP' },
    { buyerId: failedDeliveryBuyerId, balance: 5000, currency: 'COP' },
    ...multiLineRaceBuyerIds.map((id) => ({ buyerId: id, balance: 5000, currency: 'COP' })),
  ] });

  const buyerHeaders = (id) => ({
    authorization: `Bearer ${testJwt(id, ['buyer'])}`, 'content-type': 'application/json',
    'x-catalog-service-url': `http://127.0.0.1:${catalogPort}`,
  });
  const orderUrl = baseUrls['order-service'];
  const successResponse = await fetch(`${orderUrl}/api/v1/orders/checkout/async`, {
    method: 'POST', headers: buyerHeaders(buyerId),
    body: JSON.stringify({ buyerId, deliveryAddress: 'Dirección E2E 123', items: [{ productId: productIds[0], quantity: 4 }], currency: 'COP', idempotencyKey: `e2e-success-${suffix}` }),
  });
  if (successResponse.status !== 201) throw new Error(`Checkout exitoso HTTP ${successResponse.status}: ${await successResponse.text()}`);
  const successBody = await successResponse.json();
  const successOrder = await waitForOrder(orderUrl, successBody.order.id, buyerHeaders(buyerId), 'confirmed');
  assert.equal(successOrder.deliveryAddress, 'Dirección E2E 123');
  assert.equal(successOrder.items[0].productName, 'Naranja E2E');
  assert.equal(successOrder.items[0].producerName, 'Productor de prueba');
  assert.equal(Number(successOrder.totalAmount), 400);

  // Comprueba la visibilidad por rol y que los detalles conservan dirección y
  // nombres, además de bloquear pedidos ajenos al comprador/productor.
  const buyerOrderList = await requestJson(`${orderUrl}/api/v1/orders`, { headers: buyerHeaders(buyerId) }, 'Lista de pedidos del comprador');
  assert.ok(buyerOrderList.some((order) => order.id === successOrder.id));
  assert.ok(buyerOrderList.every((order) => order.buyerId === buyerId), 'la lista de comprador no incluye pedidos de terceros');
  const buyerOrderDetails = await requestJson(`${orderUrl}/api/v1/orders/${successOrder.id}`, { headers: buyerHeaders(buyerId) }, 'Detalle para comprador');
  assert.equal(buyerOrderDetails.deliveryAddress, successOrder.deliveryAddress);
  assert.equal(buyerOrderDetails.items[0].productName, 'Naranja E2E');
  assert.equal(buyerOrderDetails.items[0].producerName, 'Productor de prueba');
  const foreignBuyerOrder = await fetch(`${orderUrl}/api/v1/orders/${successOrder.id}`, { headers: buyerHeaders(lowBalanceBuyerId) });
  assert.equal(foreignBuyerOrder.status, 403, 'un comprador ajeno no puede consultar el detalle');

  const adminIdForVisibility = '70000000-0000-4000-8000-000000000001';
  const adminHeadersForVisibility = { authorization: `Bearer ${testJwt(adminIdForVisibility, ['admin'])}` };
  const adminOrderList = await requestJson(`${orderUrl}/api/v1/orders`, { headers: adminHeadersForVisibility }, 'Lista administrativa de pedidos');
  assert.ok(adminOrderList.some((order) => order.id === successOrder.id));
  const adminOrderDetails = await requestJson(`${orderUrl}/api/v1/orders/${successOrder.id}`, { headers: adminHeadersForVisibility }, 'Detalle para administración');
  assert.equal(adminOrderDetails.deliveryAddress, successOrder.deliveryAddress);
  assert.equal(adminOrderDetails.items[0].productName, 'Naranja E2E');

  const producerOrderHeaders = {
    authorization: `Bearer ${testJwt(producerUserId, ['producer'])}`,
    'x-producer-service-url': `http://127.0.0.1:${catalogPort}`,
  };
  const producerOrderList = await requestJson(`${orderUrl}/api/v1/orders`, { headers: producerOrderHeaders }, 'Lista del productor');
  assert.ok(producerOrderList.some((order) => order.id === successOrder.id));
  assert.ok(producerOrderList.every((order) => order.items.every((item) => item.producerId === producerId)), 'la lista del productor contiene únicamente sus líneas');
  const producerOrderDetails = await requestJson(`${orderUrl}/api/v1/orders/${successOrder.id}`, { headers: producerOrderHeaders }, 'Detalle para productor');
  assert.equal(producerOrderDetails.deliveryAddress, successOrder.deliveryAddress);
  assert.equal(producerOrderDetails.items.length, 1);
  assert.equal(producerOrderDetails.items[0].productName, 'Naranja E2E');
  assert.equal(producerOrderDetails.items[0].producerName, 'Productor de prueba');
  const unrelatedProducerHeaders = {
    authorization: `Bearer ${testJwt('20000000-0000-4000-8000-000000000004', ['producer'])}`,
    'x-producer-service-url': `http://127.0.0.1:${catalogPort}`,
  };
  const unrelatedProducerList = await requestJson(`${orderUrl}/api/v1/orders`, { headers: unrelatedProducerHeaders }, 'Aislamiento de pedidos de productores');
  assert.equal(unrelatedProducerList.length, 0);
  console.log('Order visibility E2E passed: buyer/admin/producer can read complete purchase details; buyer and producer ownership filters are enforced.');

  const confirmUntil = Date.now() + 12_000;
  let payment = null;
  let chargeDetails = [];
  while (Date.now() < confirmUntil) {
    payment = await payments.payment.findUnique({ where: { orderId: successOrder.id }, include: { chargeDetails: true } });
    chargeDetails = payment?.chargeDetails ?? [];
    if (chargeDetails.length === 1) break;
    await delay(250);
  }
  assert.equal(payment?.status, 'authorized');
  assert.equal(chargeDetails.length, 1, 'el pago debe registrar el detalle contable por línea');
  assert.equal(chargeDetails[0].producerName, 'Productor de prueba');
  assert.equal(Number(chargeDetails[0].commissionRate), 0.1, 'se congela el 10% global de comisión');
  const successfulWallet = await payments.wallet.findUnique({ where: { buyerId } });
  assert.equal(Number(successfulWallet.balance), 4600);
  const successInventory = await inventory.inventoryItem.findUnique({ where: { batchId: batchIds[0] } });
  assert.equal(Number(successInventory.availableKg), 16);
  const successReservation = await inventory.reservation.findFirst({ where: { orderId: successOrder.id } });
  assert.equal(successReservation?.status, 'consumed');

  // Simulate a network response loss after the order service has committed
  // and answered. The client retries with exactly the same idempotency key.
  const lostResponseKey = `e2e-lost-response-${suffix}`;
  const lostResponsePayload = { buyerId: responseLostBuyerId, deliveryAddress: 'Dirección E2E respuesta perdida', items: [{ productId: productIds[0], quantity: 1 }], currency: 'COP', idempotencyKey: lostResponseKey };
  const proxyPort = await freePort();
  let dropSuccessfulResponse = true;
  responseDropServer = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const upstreamHeaders = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !['host', 'connection', 'content-length'].includes(key.toLowerCase())));
      const upstream = await fetch(new URL(req.url, orderUrl), {
        method: req.method, headers: upstreamHeaders, body: Buffer.concat(chunks),
      });
      const upstreamBody = Buffer.from(await upstream.arrayBuffer());
      if (dropSuccessfulResponse && upstream.status === 201) {
        dropSuccessfulResponse = false;
        res.destroy();
        return;
      }
      const responseHeaders = Object.fromEntries(upstream.headers.entries());
      for (const key of ['connection', 'content-length', 'content-encoding', 'transfer-encoding']) delete responseHeaders[key];
      res.writeHead(upstream.status, responseHeaders);
      res.end(upstreamBody);
    } catch {
      if (!res.destroyed) { res.writeHead(502); res.end(); }
    }
  });
  await new Promise((resolve, reject) => responseDropServer.listen(proxyPort, '127.0.0.1', resolve).once('error', reject));
  let responseWasLost = false;
  try {
    await fetch(`http://127.0.0.1:${proxyPort}/api/v1/orders/checkout/async`, {
      method: 'POST', headers: buyerHeaders(responseLostBuyerId), body: JSON.stringify(lostResponsePayload),
    });
  } catch { responseWasLost = true; }
  assert.equal(responseWasLost, true, 'el primer cliente debe observar una respuesta perdida');
  const committedLostResponseOrder = await waitFor(
    () => orders.order.findUnique({ where: { idempotencyKey: lostResponseKey }, include: { items: true } }),
    'pedido confirmado por el servidor aunque se perdiera la respuesta HTTP',
  );
  const retriedResponse = await fetch(`http://127.0.0.1:${proxyPort}/api/v1/orders/checkout/async`, {
    method: 'POST', headers: buyerHeaders(responseLostBuyerId), body: JSON.stringify(lostResponsePayload),
  });
  assert.equal(retriedResponse.status, 201);
  const retriedBody = await retriedResponse.json();
  assert.equal(retriedBody.order.id, committedLostResponseOrder.id);
  assert.equal(retriedBody.replayed, true, 'el servidor debe reconocer el reintento idempotente');
  await waitForOrder(orderUrl, committedLostResponseOrder.id, buyerHeaders(responseLostBuyerId), 'confirmed');
  assert.equal(await orders.order.count({ where: { idempotencyKey: lostResponseKey } }), 1);
  assert.equal(await orders.outboxEvent.count({ where: { aggregateId: committedLostResponseOrder.id, eventType: 'order.created' } }), 1);
  assert.equal(await inventory.reservation.count({ where: { orderId: committedLostResponseOrder.id, status: 'consumed' } }), 1);
  assert.equal(await payments.payment.count({ where: { orderId: committedLostResponseOrder.id, status: 'authorized' } }), 1);
  assert.equal(Number((await payments.wallet.findUnique({ where: { buyerId: responseLostBuyerId } })).balance), 4900);
  await new Promise((resolve) => responseDropServer.close(resolve));
  responseDropServer = undefined;
  console.log('Checkout E2E respuesta perdida aprobado: reintento por la misma clave conserva un pedido, outbox, reserva y débito.');

  const deliveryPlan = await waitFor(async () => {
    const plan = await logistics.deliveryPlan.findUnique({ where: { orderId: successOrder.id }, include: { deliveries: { include: { lots: true } } } });
    return plan?.paymentId && plan.deliveries.length === 1 ? plan : null;
  }, 'plan logístico enlazado al pago');

  // Reproduce el mismo evento durable para comprobar que la inbox evita crear
  // una segunda entrega. Después envía un mensaje malformado para verificar el
  // reintento acotado y el dead-letter routing del consumer real de Logística.
  const confirmationEvent = await orders.outboxEvent.findFirst({ where: { eventType: 'order.confirmed', aggregateId: successOrder.id } });
  assert.ok(confirmationEvent, 'debe existir el evento de confirmación persistido en outbox');
  assert.equal(await logistics.processedEvent.count({ where: { eventId: confirmationEvent.id } }), 1, 'Logística debe haber procesado la confirmación original');
  rabbitMonitorChannel.publish(exchange, confirmationEvent.routingKey ?? confirmationEvent.eventType, Buffer.from(JSON.stringify({
    event_id: confirmationEvent.id,
    event_type: confirmationEvent.eventType,
    source_service: confirmationEvent.sourceService,
    entity_id: confirmationEvent.aggregateId,
    entity_version: confirmationEvent.entityVersion,
    schema_version: confirmationEvent.schemaVersion,
    occurred_at: confirmationEvent.occurredAt.toISOString(),
    correlation_id: confirmationEvent.correlationId,
    payload: confirmationEvent.payload,
  })), { persistent: true, contentType: 'application/json', messageId: confirmationEvent.id });
  await rabbitMonitorChannel.waitForConfirms();
  await waitFor(async () => {
    const queue = await rabbitMonitorChannel.checkQueue('logistics-service.orders');
    const dead = await rabbitMonitorChannel.checkQueue('logistics-service.orders.dead');
    return queue.messageCount === 0 && dead.messageCount === 0;
  }, 'redelivery idempotente de order.confirmed');
  await delay(500);
  assert.equal(await logistics.processedEvent.count({ where: { eventId: confirmationEvent.id } }), 1, 'la reentrega no duplica el registro inbox');
  assert.equal(await logistics.deliveryPlan.count({ where: { orderId: successOrder.id } }), 1, 'la reentrega no duplica el plan logístico');
  assert.equal(await logistics.delivery.count({ where: { planId: deliveryPlan.id } }), 1, 'la reentrega no duplica entregas');

  const deadQueue = 'logistics-service.orders.dead';
  const deadBefore = (await rabbitMonitorChannel.checkQueue(deadQueue)).messageCount;
  rabbitMonitorChannel.publish(exchange, 'order.confirmed', Buffer.from('{malformed event'), { persistent: true, contentType: 'application/json', messageId: `e2e-poison-${suffix}` });
  await rabbitMonitorChannel.waitForConfirms();
  const deadAfter = await waitFor(async () => {
    const queue = await rabbitMonitorChannel.checkQueue(deadQueue);
    return queue.messageCount > deadBefore ? queue.messageCount : null;
  }, 'mensaje malformado en dead-letter queue');
  assert.equal(deadAfter, deadBefore + 1, 'un mensaje inválido debe ir a DLQ tras un único reintento');

  // Discard only the deliberately malformed fixture, then redrive a valid
  // duplicate event through the operator tool to verify dry-run and idempotency.
  const poison = await rabbitMonitorChannel.get(deadQueue, { noAck: false });
  assert.equal(poison?.properties.messageId, `e2e-poison-${suffix}`);
  rabbitMonitorChannel.ack(poison);
  const redriveEnvelope = {
    event_id: confirmationEvent.id,
    event_type: confirmationEvent.eventType,
    source_service: confirmationEvent.sourceService,
    entity_id: confirmationEvent.aggregateId,
    entity_version: confirmationEvent.entityVersion,
    schema_version: confirmationEvent.schemaVersion,
    occurred_at: confirmationEvent.occurredAt.toISOString(),
    correlation_id: confirmationEvent.correlationId,
    payload: confirmationEvent.payload,
  };
  rabbitMonitorChannel.sendToQueue(deadQueue, Buffer.from(JSON.stringify(redriveEnvelope)), {
    persistent: true, contentType: 'application/json', messageId: confirmationEvent.id,
  });
  await rabbitMonitorChannel.waitForConfirms();
  const redriveEnv = localEnvironment({
    RABBITMQ_URL: `amqp://${rabbitUser}:${rabbitPassword}@127.0.0.1:${rabbitPort}`,
    RABBITMQ_EXCHANGE: exchange,
  });
  const redriveArgs = ['scripts/rabbitmq-dlq-redrive.mjs', '--queue', deadQueue, '--limit', '1'];
  const dryRun = run(process.execPath, redriveArgs, { env: redriveEnv });
  assert.match(dryRun, /Dry-run/);
  assert.equal((await rabbitMonitorChannel.checkQueue(deadQueue)).messageCount, 1, 'dry-run no modifica la DLQ');
  const redrive = run(process.execPath, [...redriveArgs, '--routing-key', 'order.confirmed', '--apply'], { env: redriveEnv });
  assert.match(redrive, /republished=1/);
  await waitFor(async () => {
    const source = await rabbitMonitorChannel.checkQueue('logistics-service.orders');
    const dead = await rabbitMonitorChannel.checkQueue(deadQueue);
    return source.messageCount === 0 && dead.messageCount === 0 ? true : null;
  }, 'redrive idempotente desde DLQ');
  assert.equal(await logistics.processedEvent.count({ where: { eventId: confirmationEvent.id } }), 1, 'redrive no duplica la inbox');
  assert.equal(await logistics.deliveryPlan.count({ where: { orderId: successOrder.id } }), 1, 'redrive no duplica el plan');
  assert.equal(await logistics.delivery.count({ where: { planId: deliveryPlan.id } }), 1, 'redrive no duplica entregas');
  console.log('RabbitMQ E2E aprobado: DLQ por poison message, dry-run sin cambios y redrive confirmado sin duplicar efectos.');

  const delivery = deliveryPlan.deliveries[0];
  const driverUserId = '60000000-0000-4000-8000-000000000001';
  const staffHeaders = (id, roles) => ({ authorization: `Bearer ${testJwt(id, roles.split(','))}`, 'content-type': 'application/json' });
  const adminHeaders = staffHeaders('70000000-0000-4000-8000-000000000001', 'admin');
  const driverHeaders = staffHeaders(driverUserId, 'driver');
  const logisticsUrl = baseUrls['logistics-service'];
  const zoneCode = `E2E-${suffix}`;
  await requestJson(`${logisticsUrl}/api/v1/logistics/zones`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ code: zoneCode, name: 'Zona E2E' }) }, 'Crear zona de prueba');
  const driver = await requestJson(`${logisticsUrl}/api/v1/drivers`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ userId: driverUserId, fullName: 'Conductor E2E', phone: '+573001112233', licenseNumber: `E2E-${suffix}` }) }, 'Crear conductor de prueba');
  const vehicle = await requestJson(`${logisticsUrl}/api/v1/vehicles`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ plate: `E${String(Date.now()).slice(-6)}`, capacityKg: 100 }) }, 'Crear vehículo de prueba');
  const windowStart = new Date(delivery.windowStart);
  const windowEnd = new Date(delivery.windowEnd);
  const pickupAt = new Date(windowStart.getTime() + 60 * 60 * 1000);
  const dropoffAt = new Date(windowStart.getTime() + 2 * 60 * 60 * 1000);
  const route = await requestJson(`${logisticsUrl}/api/v1/routes`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      driverId: driver.id, vehicleId: vehicle.id, zoneCode,
      scheduledDate: windowStart.toISOString(), scheduledEnd: windowEnd.toISOString(), deliveryIds: [delivery.id],
      stops: [
        { sequence: 1, deliveryId: delivery.id, type: 'pickup', farmId: delivery.lots[0].farmId, address: delivery.lots[0].pickupAddress, plannedAt: pickupAt.toISOString() },
        { sequence: 2, deliveryId: delivery.id, type: 'dropoff', address: delivery.deliveryAddress, plannedAt: dropoffAt.toISOString() },
      ],
    }),
  }, 'Crear ruta de prueba');
  const dispatchResponse = await fetch(`${logisticsUrl}/api/v1/routes/${route.id}/dispatch`, {
    method: 'PATCH', headers: { ...driverHeaders, 'x-operation-id': '80000000-0000-4000-8000-000000000001', 'x-correlation-id': successOrder.id },
  });
  if (!dispatchResponse.ok) throw new Error(`Despachar ruta HTTP ${dispatchResponse.status}: ${await dispatchResponse.text()}`);
  const paymentLocked = await payments.payment.findUnique({ where: { id: deliveryPlan.paymentId } });
  assert.equal(paymentLocked.fulfillmentRouteId, route.id, 'el pago autorizado queda bloqueado para la ruta despachada');
  const voidResponse = await fetch(`${baseUrls['payment-service']}/api/v1/payments/${deliveryPlan.paymentId}/void`, {
    method: 'PATCH', headers: { ...driverHeaders, 'x-internal-api-key': internalApiKey },
  });
  assert.equal(voidResponse.status, 409, 'no debe anularse el pago después del bloqueo para despacho');

  for (const [index, stop] of route.stops.entries()) {
    const operationId = index === 0 ? '80000000-0000-4000-8000-000000000002' : '80000000-0000-4000-8000-000000000003';
    await requestJson(`${logisticsUrl}/api/v1/routes/${route.id}/stops/${stop.id}/arrive`, {
      method: 'PATCH', headers: { ...driverHeaders, 'x-operation-id': operationId },
    }, 'Registrar llegada a parada');
  }
  const closeBody = { status: 'completed', acceptedLots: delivery.lots.map((lot) => ({ reservationId: lot.reservationId, acceptedQuantityKg: Number(lot.quantityKg) })) };
  await requestJson(`${logisticsUrl}/api/v1/deliveries/${delivery.id}/close`, {
    method: 'PATCH', headers: { ...driverHeaders, 'x-operation-id': '80000000-0000-4000-8000-000000000004', 'x-correlation-id': successOrder.id }, body: JSON.stringify(closeBody),
  }, 'Cerrar entrega completa');
  await waitFor(async () => {
    const settled = await payments.payment.findUnique({ where: { id: deliveryPlan.paymentId } });
    return settled?.status === 'captured' ? settled : null;
  }, 'captura del pago al cerrar entrega');
  const payoutLine = await waitFor(async () => {
    const rows = await payments.producerPayoutItem.findMany({ where: { paymentId: deliveryPlan.paymentId } });
    return rows.length === 1 ? rows[0] : null;
  }, 'liquidación del productor');
  assert.equal(Number(payoutLine.grossAmount), 400);
  assert.equal(Number(payoutLine.commissionRate), 0.1);
  assert.equal(Number(payoutLine.commissionAmount), 40);
  assert.equal(Number(payoutLine.netAmount), 360);
  const deliveredOrder = await waitForOrder(orderUrl, successOrder.id, buyerHeaders(buyerId), 'delivered');
  assert.equal(deliveredOrder.deliveryAddress, 'Dirección E2E 123');

  const adminId = '70000000-0000-4000-8000-000000000001';
  const forgedGatewayHeaders = {
    ...buyerHeaders(buyerId),
    'x-gateway-user-id': adminId,
    'x-gateway-user-roles': 'admin',
  };
  const forgedRoleResponse = await fetch(`${baseUrls['payment-service']}/api/v1/payments/payouts/${payoutLine.payoutId}/complete`, {
    method: 'PATCH', headers: forgedGatewayHeaders,
    body: JSON.stringify({ providerReference: `FORGED-${suffix}` }),
  });
  assert.equal(forgedRoleResponse.status, 403, 'un JWT de comprador no obtiene permisos admin al falsificar cabeceras Gateway');
  const forgedIdentityResponse = await fetch(`${baseUrls['payment-service']}/api/v1/payments/wallet/${adminId}`, {
    headers: { ...buyerHeaders(buyerId), 'x-gateway-user-id': adminId },
  });
  assert.equal(forgedIdentityResponse.status, 403, 'la identidad del comprador proviene del JWT, no de una cabecera Gateway');
  const missingTokenResponse = await fetch(`${baseUrls['payment-service']}/api/v1/payments/payouts`, {
    headers: { 'x-gateway-user-id': adminId, 'x-gateway-user-roles': 'admin' },
  });
  assert.equal(missingTokenResponse.status, 401, 'las cabeceras Gateway sin JWT no autentican una llamada directa');

  // A refund after a real payout must never rewrite the completed transfer.
  // It credits the buyer and carries a negative producer adjustment forward.
  const transferReference = `E2E-TRANSFER-${suffix}`;
  await requestJson(`${baseUrls['payment-service']}/api/v1/payments/payouts/${payoutLine.payoutId}/complete`, {
    method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ providerReference: transferReference }),
  }, 'Registrar transferencia de prueba');
  const paidPayout = await payments.producerPayout.findUnique({ where: { id: payoutLine.payoutId } });
  assert.equal(paidPayout.status, 'paid');
  assert.equal(paidPayout.providerReference, transferReference);
  const paymentId = deliveryPlan.paymentId;
  await requestJson(`${baseUrls['payment-service']}/api/v1/payments/${paymentId}/refund`, {
    method: 'PATCH', headers: { ...adminHeaders, 'x-correlation-id': successOrder.id },
  }, 'Reembolsar pago con liquidacion ya transferida');
  const refundedPayment = await payments.payment.findUnique({ where: { id: paymentId } });
  assert.equal(refundedPayment.status, 'refunded');
  assert.equal(Number(refundedPayment.capturedAmount), 400);
  const refundedWallet = await payments.wallet.findUnique({ where: { buyerId } });
  assert.equal(Number(refundedWallet.balance), 5000, 'el reembolso posterior a la transferencia acredita TerraWallet una sola vez');
  const refundAdjustment = await payments.settlementAdjustment.findFirst({
    where: { refund: { paymentId } }, include: { payout: true, refund: true },
  });
  assert.ok(refundAdjustment, 'el reembolso posterior a la transferencia crea un ajuste auditable');
  assert.equal(Number(refundAdjustment.refund.amount), 400);
  assert.equal(Number(refundAdjustment.amount), -360, 'el ajuste recupera solo el neto transferido al productor');
  assert.equal(refundAdjustment.payout.status, 'carried');
  assert.equal(Number(refundAdjustment.payout.netAmount), -360);
  assert.equal(refundAdjustment.payout.producerId, producerId);
  assert.equal(refundAdjustment.payout.periodStart.toISOString(), paidPayout.periodEnd.toISOString());
  assert.equal(await payments.refund.count({ where: { paymentId } }), 1);
  assert.equal(await payments.outboxEvent.count({ where: { eventType: 'payment.refunded', aggregateId: paymentId } }), 1);
  assert.equal(await payments.outboxEvent.count({ where: { eventType: 'payout.completed', aggregateId: payoutLine.payoutId } }), 1);
  await requestJson(`${baseUrls['payment-service']}/api/v1/payments/${paymentId}/refund`, {
    method: 'PATCH', headers: { ...adminHeaders, 'x-correlation-id': successOrder.id },
  }, 'Reintentar reembolso ya aplicado');
  assert.equal(await payments.refund.count({ where: { paymentId } }), 1, 'reintentar el reembolso no duplica el asiento');
  assert.equal(Number((await payments.wallet.findUnique({ where: { buyerId } })).balance), 5000);

  async function checkoutAndClose({ caseName, caseBuyerId, deliveryStatus, acceptedQuantity, operationPrefix }) {
    const checkout = await fetch(`${orderUrl}/api/v1/orders/checkout/async`, {
      method: 'POST', headers: buyerHeaders(caseBuyerId),
      body: JSON.stringify({ buyerId: caseBuyerId, deliveryAddress: `Dirección E2E ${caseName}`, items: [{ productId: productIds[0], quantity: 4 }], currency: 'COP', idempotencyKey: `e2e-${caseName}-${suffix}` }),
    });
    if (checkout.status !== 201) throw new Error(`Checkout ${caseName} HTTP ${checkout.status}: ${await checkout.text()}`);
    const body = await checkout.json();
    const order = await waitForOrder(orderUrl, body.order.id, buyerHeaders(caseBuyerId), 'confirmed');
    const plan = await waitFor(async () => {
      const found = await logistics.deliveryPlan.findUnique({ where: { orderId: order.id }, include: { deliveries: { include: { lots: true } } } });
      return found?.paymentId && found.deliveries.length === 1 ? found : null;
    }, `plan logístico ${caseName}`);
    const caseDelivery = plan.deliveries[0];
    const caseStart = new Date(caseDelivery.windowStart);
    const caseEnd = new Date(caseDelivery.windowEnd);
    const caseRoute = await requestJson(`${logisticsUrl}/api/v1/routes`, {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({
        driverId: driver.id, vehicleId: vehicle.id, zoneCode,
        scheduledDate: caseStart.toISOString(), scheduledEnd: caseEnd.toISOString(), deliveryIds: [caseDelivery.id],
        stops: [
          { sequence: 1, deliveryId: caseDelivery.id, type: 'pickup', farmId: caseDelivery.lots[0].farmId, address: caseDelivery.lots[0].pickupAddress, plannedAt: new Date(caseStart.getTime() + 60 * 60 * 1000).toISOString() },
          { sequence: 2, deliveryId: caseDelivery.id, type: 'dropoff', address: caseDelivery.deliveryAddress, plannedAt: new Date(caseStart.getTime() + 2 * 60 * 60 * 1000).toISOString() },
        ],
      }),
    }, `Crear ruta ${caseName}`);
    await requestJson(`${logisticsUrl}/api/v1/routes/${caseRoute.id}/dispatch`, {
      method: 'PATCH', headers: { ...driverHeaders, 'x-operation-id': `${operationPrefix}-0000-4000-8000-000000000001`, 'x-correlation-id': order.id },
    }, `Despachar ruta ${caseName}`);
    for (const [index, stop] of caseRoute.stops.entries()) {
      await requestJson(`${logisticsUrl}/api/v1/routes/${caseRoute.id}/stops/${stop.id}/arrive`, {
        method: 'PATCH', headers: { ...driverHeaders, 'x-operation-id': `${operationPrefix}-0000-4000-8000-00000000000${index + 2}` },
      }, `Registrar parada ${caseName}`);
    }
    await requestJson(`${logisticsUrl}/api/v1/deliveries/${caseDelivery.id}/close`, {
      method: 'PATCH', headers: { ...driverHeaders, 'x-operation-id': `${operationPrefix}-0000-4000-8000-000000000004`, 'x-correlation-id': order.id },
      body: JSON.stringify({ status: deliveryStatus, acceptedLots: caseDelivery.lots.map((lot) => ({ reservationId: lot.reservationId, acceptedQuantityKg: acceptedQuantity })) }),
    }, `Cerrar entrega ${caseName}`);
    const expectedAcceptedAmount = acceptedQuantity * 100;
    const payment = await waitFor(async () => {
      const found = await payments.payment.findUnique({ where: { id: plan.paymentId } });
      return found && found.status === (expectedAcceptedAmount ? 'captured' : 'voided') ? found : null;
    }, `liquidación de pago ${caseName}`);
    assert.equal(Number(payment.capturedAmount), expectedAcceptedAmount);
    const finalOrder = await waitForOrder(orderUrl, order.id, buyerHeaders(caseBuyerId), expectedAcceptedAmount ? 'partial' : 'cancelled');
    assert.equal(Number(finalOrder.settledAmount), expectedAcceptedAmount);
    const wallet = await payments.wallet.findUnique({ where: { buyerId: caseBuyerId } });
    assert.equal(Number(wallet.balance), 5000 - expectedAcceptedAmount, `el comprador recibe el saldo no aceptado en ${caseName}`);
    const lines = await payments.producerPayoutItem.findMany({ where: { paymentId: plan.paymentId } });
    if (expectedAcceptedAmount) {
      assert.equal(lines.length, 1);
      assert.equal(Number(lines[0].grossAmount), expectedAcceptedAmount);
      assert.equal(Number(lines[0].commissionRate), 0.1);
      assert.equal(Number(lines[0].commissionAmount), expectedAcceptedAmount * 0.1);
      assert.equal(Number(lines[0].netAmount), expectedAcceptedAmount * 0.9);
    } else {
      assert.equal(lines.length, 0, 'una entrega fallida no crea liquidación para el productor');
    }
  }

  await checkoutAndClose({ caseName: 'partial', caseBuyerId: partialBuyerId, deliveryStatus: 'partial', acceptedQuantity: 2, operationPrefix: '90000000' });
  await checkoutAndClose({ caseName: 'failed-delivery', caseBuyerId: failedDeliveryBuyerId, deliveryStatus: 'failed', acceptedQuantity: 0, operationPrefix: 'a0000000' });
  console.log('Logística E2E aprobado: entrega completa y liquidación, parcial con reembolso de saldo no aceptado, y fallida con anulación y reembolso total; comisión global del 10%.');

  const failureResponse = await fetch(`${orderUrl}/api/v1/orders/checkout/async`, {
    method: 'POST', headers: buyerHeaders(lowBalanceBuyerId),
    body: JSON.stringify({ buyerId: lowBalanceBuyerId, deliveryAddress: 'Dirección E2E sin saldo', items: [{ productId: productIds[1], quantity: 2 }], currency: 'COP', idempotencyKey: `e2e-insufficient-${suffix}` }),
  });
  if (failureResponse.status !== 201) throw new Error(`Checkout compensable HTTP ${failureResponse.status}: ${await failureResponse.text()}`);
  const failureBody = await failureResponse.json();
  const failedOrder = await waitForOrder(orderUrl, failureBody.order.id, buyerHeaders(lowBalanceBuyerId), 'cancelled');
  assert.equal(failedOrder.paymentStatus, 'failed');
  const failureWallet = await payments.wallet.findUnique({ where: { buyerId: lowBalanceBuyerId } });
  assert.equal(Number(failureWallet.balance), 10, 'un rechazo no debe debitar el saldo');
  assert.equal(await payments.payment.count({ where: { orderId: failedOrder.id } }), 0);
  const releaseUntil = Date.now() + 12_000;
  let released = null;
  let failedInventory = null;
  while (Date.now() < releaseUntil) {
    released = await inventory.reservation.findFirst({ where: { orderId: failedOrder.id } });
    failedInventory = await inventory.inventoryItem.findUnique({ where: { batchId: batchIds[1] } });
    if (released?.status === 'released' && Number(failedInventory?.availableKg) === 20) break;
    await delay(250);
  }
  assert.equal(Number(failedInventory.availableKg), 20, 'la compensación devuelve el stock reservado');
  assert.equal(released?.status, 'released');

  // Inject a test-only pause after Logistics commits the event but before ACK,
  // kill the actual consumer process, and prove redelivery stays idempotent.
  const logisticsServicePort = appPorts[required.indexOf('logistics-service')];
  const logisticsDatabaseUrl = urls[required.indexOf('logistics-service')];
  const logisticsReadyUrl = `${baseUrls['logistics-service']}/api/v1/health/ready`;
  await stopService('logistics-service');
  const crashRecoveryKey = `e2e-logistics-crash-${suffix}`;
  const crashCheckoutResponse = await fetch(`${orderUrl}/api/v1/orders/checkout/async`, {
    method: 'POST', headers: buyerHeaders(logisticsCrashBuyerId),
    body: JSON.stringify({ buyerId: logisticsCrashBuyerId, deliveryAddress: 'Consumer restart E2E address', items: [{ productId: productIds[0], quantity: 1 }], currency: 'COP', idempotencyKey: crashRecoveryKey }),
  });
  if (crashCheckoutResponse.status !== 201) throw new Error(`Consumer recovery checkout HTTP ${crashCheckoutResponse.status}: ${await crashCheckoutResponse.text()}`);
  const crashCheckoutBody = await crashCheckoutResponse.json();
  const crashRecoveryOrder = await waitForOrder(orderUrl, crashCheckoutBody.order.id, buyerHeaders(logisticsCrashBuyerId), 'confirmed');
  const crashConfirmationEvent = await waitFor(async () => {
    const event = await orders.outboxEvent.findFirst({ where: { eventType: 'order.confirmed', aggregateId: crashRecoveryOrder.id } });
    const queue = await rabbitMonitorChannel.checkQueue('logistics-service.orders');
    return event?.status === 'published' && queue.messageCount === 1 ? event : null;
  }, 'published order.confirmed with Logistics consumer stopped');
  startService('logistics-service', logisticsServicePort, logisticsDatabaseUrl, {
    NODE_ENV: 'test', OUTBOX_PUBLISHER_ENABLED: 'true',
    RABBITMQ_TEST_HOLD_BEFORE_ACK_MESSAGE_ID: crashConfirmationEvent.id,
  });
  await waitForReady(logisticsReadyUrl, 'Logistics test consumer before simulated crash');
  await waitFor(async () => {
    const processed = await logistics.processedEvent.count({ where: { eventId: crashConfirmationEvent.id } });
    const plan = await logistics.deliveryPlan.count({ where: { orderId: crashRecoveryOrder.id } });
    return processed === 1 && plan === 1 ? true : null;
  }, 'Logistics committed order.confirmed but paused before ACK');
  await crashService('logistics-service');
  await waitFor(async () => (await rabbitMonitorChannel.checkQueue('logistics-service.orders')).messageCount === 1, 'RabbitMQ requeues the message after Logistics process crash');
  const redeliveredMessage = await rabbitMonitorChannel.get('logistics-service.orders', { noAck: false });
  assert.equal(redeliveredMessage?.fields.redelivered, true, 'RabbitMQ marks the unacked message as redelivered');
  assert.equal(JSON.parse(redeliveredMessage.content.toString()).event_id, crashConfirmationEvent.id);
  await rabbitMonitorChannel.close();
  rabbitMonitorChannel = undefined;
  await rabbitMonitor.close();
  rabbitMonitor = undefined;
  await openRabbitMonitor();
  await waitFor(async () => (await rabbitMonitorChannel.checkQueue('logistics-service.orders')).messageCount === 1, 'redelivered message requeued for the restarted consumer');
  startService('logistics-service', logisticsServicePort, logisticsDatabaseUrl);
  await waitForReady(logisticsReadyUrl, 'Logistics restarted after the commit/ack crash gap');
  await waitFor(async () => {
    const queue = await rabbitMonitorChannel.checkQueue('logistics-service.orders');
    const count = await logistics.processedEvent.count({ where: { eventId: crashConfirmationEvent.id } });
    return queue.messageCount === 0 && count === 1 ? true : null;
  }, 'redelivery without duplicating the pre-crash commit');
  assert.equal(await logistics.deliveryPlan.count({ where: { orderId: crashRecoveryOrder.id } }), 1, 'redelivery does not duplicate the plan');
  assert.equal(await logistics.delivery.count({ where: { orderId: crashRecoveryOrder.id } }), 1, 'redelivery does not duplicate the delivery');
  assert.equal(await payments.payment.count({ where: { orderId: crashRecoveryOrder.id, status: 'authorized' } }), 1);
  assert.equal(Number((await payments.wallet.findUnique({ where: { buyerId: logisticsCrashBuyerId } })).balance), 4900, 'logistics crash does not duplicate the debit');
  console.log('Consumer recovery E2E approved: Logistics crashed after commit but before ACK; RabbitMQ redelivered the event and inbox idempotency prevented duplicate delivery records.');

  const lastUnitRequests = await Promise.all([buyerId, lowBalanceBuyerId].map((requestBuyerId, index) => fetch(`${baseUrls['inventory-service']}/inventory/reservations`, {
    method: 'POST',
    headers: buyerHeaders(requestBuyerId),
    body: JSON.stringify({ product_id: productIds[2], quantity_kg: 1, idempotency_key: `e2e-last-unit-${suffix}-${index}` }),
  })));
  const lastUnitStatuses = lastUnitRequests.map((response) => response.status);
  assert.equal(lastUnitStatuses.filter((status) => status === 201).length, 1, 'solo una reserva por la última unidad debe confirmarse');
  assert.ok(lastUnitStatuses.every((status) => status === 201 || status === 400 || status === 409), `la solicitud perdedora debe recibir un rechazo de dominio: ${lastUnitStatuses.join(', ')}`);
  const lastUnitItem = await inventory.inventoryItem.findUnique({ where: { batchId: batchIds[2] } });
  assert.equal(Number(lastUnitItem.availableKg), 0);
  assert.equal(await inventory.reservation.count({ where: { itemId: lastUnitItem.id, status: 'active' } }), 1);

  // Two simultaneous multi-line checkouts both reserve the plentiful first
  // product, then contend for the final unit of the second. The loser must be
  // cancelled and its already-created first-line reservation released.
  const firstLineStockBeforeRace = Number((await inventory.inventoryItem.findUnique({ where: { batchId: batchIds[0] } })).availableKg);
  const multiLineRaceResponses = await Promise.all(multiLineRaceBuyerIds.map((id, index) => fetch(`${orderUrl}/api/v1/orders/checkout/async`, {
    method: 'POST', headers: buyerHeaders(id),
    body: JSON.stringify({ buyerId: id, deliveryAddress: `Dirección E2E carrera multilínea ${index + 1}`, items: [
      { productId: productIds[0], quantity: 1 }, { productId: productIds[3], quantity: 1 },
    ], currency: 'COP', idempotencyKey: `e2e-multiline-race-${suffix}-${index}` }),
  })));
  const multiLineRaceOrders = await Promise.all(multiLineRaceResponses.map(async (response) => {
    if (response.status !== 201) throw new Error(`Checkout de carrera multilínea HTTP ${response.status}: ${await response.text()}`);
    const body = await response.json();
    return { id: body.order.id, buyerId: body.order.buyerId };
  }));
  const settledRaceOrders = await Promise.all(multiLineRaceOrders.map(async (order) => {
    const confirmed = await waitFor(async () => {
      const current = await requestJson(`${orderUrl}/api/v1/orders/${order.id}`, { headers: buyerHeaders(order.buyerId) }, 'Consultar checkout multilínea');
      return ['confirmed', 'cancelled'].includes(current.status) ? current : null;
    }, `resultado terminal de checkout multilínea ${order.id}`);
    return confirmed;
  }));
  assert.equal(settledRaceOrders.filter((order) => order.status === 'confirmed').length, 1, 'solo un checkout multilínea gana la última unidad');
  assert.equal(settledRaceOrders.filter((order) => order.status === 'cancelled').length, 1, 'el checkout que pierde inventario se compensa');
  const winningRaceOrder = settledRaceOrders.find((order) => order.status === 'confirmed');
  const losingRaceOrder = settledRaceOrders.find((order) => order.status === 'cancelled');
  const winnerReservations = await inventory.reservation.findMany({ where: { orderId: winningRaceOrder.id } });
  const loserReservations = await inventory.reservation.findMany({ where: { orderId: losingRaceOrder.id } });
  assert.equal(winnerReservations.length, 2);
  assert.ok(winnerReservations.every((reservation) => reservation.status === 'consumed'), 'las dos líneas ganadoras se consumen juntas');
  assert.equal(loserReservations.length, 1, 'el pedido perdedor no retiene reserva de la línea que agotó stock');
  assert.equal(loserReservations[0].status, 'released', 'la reserva de su primera línea se libera durante compensación');
  assert.equal(await payments.payment.count({ where: { orderId: winningRaceOrder.id, status: 'authorized' } }), 1);
  assert.equal(await payments.payment.count({ where: { orderId: losingRaceOrder.id } }), 0, 'el pedido perdedor no llega a cobrar');
  assert.equal(Number((await payments.wallet.findUnique({ where: { buyerId: winningRaceOrder.buyerId } })).balance), 4650);
  assert.equal(Number((await payments.wallet.findUnique({ where: { buyerId: losingRaceOrder.buyerId } })).balance), 5000, 'el checkout compensado no debita la billetera');
  assert.equal(Number((await inventory.inventoryItem.findUnique({ where: { batchId: batchIds[0] } })).availableKg), firstLineStockBeforeRace - 1, 'el stock de la primera línea solo baja por la compra ganadora');
  assert.equal(Number((await inventory.inventoryItem.findUnique({ where: { batchId: batchIds[3] } })).availableKg), 0, 'la última unidad de la segunda línea se consume una sola vez');
  console.log('Checkout concurrency E2E approved: a losing multi-line order releases earlier reservations, leaves its wallet untouched, and only one buyer consumes the contested final unit.');

  // Simula que Pedidos reinicia con un outbox durable todavía sin publicar:
  // primero se pausa solo su publicador, se crea el pedido y se verifica que no
  // haya efectos laterales; después se reinicia con el publicador activo.
  const recoveryBuyerId = '10000000-0000-4000-8000-000000000005';
  await payments.wallet.create({ data: { buyerId: recoveryBuyerId, balance: 5000, currency: 'COP' } });
  const orderPort = appPorts[required.indexOf('order-service')];
  const orderDatabaseUrl = urls[required.indexOf('order-service')];
  const orderReadyUrl = `${baseUrls['order-service']}/api/v1/health/ready`;
  await stopService('order-service');
  startService('order-service', orderPort, orderDatabaseUrl, { OUTBOX_PUBLISHER_ENABLED: 'false' });
  await waitForReady(orderReadyUrl, 'order-service con outbox pausado');

  const recoveryIdempotencyKey = `e2e-outbox-restart-${suffix}`;
  const recoveryCheckout = await fetch(`${orderUrl}/api/v1/orders/checkout/async`, {
    method: 'POST', headers: buyerHeaders(recoveryBuyerId),
    body: JSON.stringify({ buyerId: recoveryBuyerId, deliveryAddress: 'Dirección E2E recuperación', items: [{ productId: productIds[1], quantity: 2 }], currency: 'COP', idempotencyKey: recoveryIdempotencyKey }),
  });
  if (recoveryCheckout.status !== 201) throw new Error(`Checkout de recuperación HTTP ${recoveryCheckout.status}: ${await recoveryCheckout.text()}`);
  const recoveryBody = await recoveryCheckout.json();
  const recoveryOrderId = recoveryBody?.order?.id;
  assert.ok(recoveryOrderId, 'el checkout debe persistir el pedido aunque el publicador esté pausado');
  assert.equal(recoveryBody.order.status, 'pending');
  const pendingOutbox = await orders.outboxEvent.findFirst({ where: { eventType: 'order.created', aggregateId: recoveryOrderId } });
  assert.equal(pendingOutbox?.status, 'pending', 'order.created debe permanecer durable en el outbox');
  assert.equal(await inventory.reservation.count({ where: { orderId: recoveryOrderId } }), 0, 'no se reserva inventario antes de publicar el evento');
  assert.equal(await payments.payment.count({ where: { orderId: recoveryOrderId } }), 0, 'no se cobra antes de publicar el evento');

  await stopService('order-service');
  startService('order-service', orderPort, orderDatabaseUrl);
  await waitForReady(orderReadyUrl, 'order-service reiniciado con outbox activo');
  const recoveredOrder = await waitForOrder(orderUrl, recoveryOrderId, buyerHeaders(recoveryBuyerId), 'confirmed');
  const recoveredOutbox = await waitFor(async () => {
    const event = await orders.outboxEvent.findUnique({ where: { id: pendingOutbox.id } });
    return event?.status === 'published' ? event : null;
  }, 'publicación del outbox pendiente tras el reinicio');
  assert.equal(recoveredOrder.deliveryAddress, 'Dirección E2E recuperación');
  assert.equal(recoveredOutbox.status, 'published');
  assert.equal(await inventory.reservation.count({ where: { orderId: recoveryOrderId, status: 'consumed' } }), 1, 'el evento recuperado debe generar una sola reserva consumida');
  assert.equal(await payments.payment.count({ where: { orderId: recoveryOrderId, status: 'authorized' } }), 1, 'el evento recuperado debe crear un solo cargo');
  assert.equal(Number((await payments.wallet.findUnique({ where: { buyerId: recoveryBuyerId } })).balance), 4500, 'el reinicio no duplica el débito TerraWallet');

  const replayRecovery = await fetch(`${orderUrl}/api/v1/orders/checkout/async`, {
    method: 'POST', headers: buyerHeaders(recoveryBuyerId),
    body: JSON.stringify({ buyerId: recoveryBuyerId, deliveryAddress: 'Dirección E2E recuperación', items: [{ productId: productIds[1], quantity: 2 }], currency: 'COP', idempotencyKey: recoveryIdempotencyKey }),
  });
  assert.equal(replayRecovery.status, 201);
  const replayRecoveryBody = await replayRecovery.json();
  assert.equal(replayRecoveryBody.order.id, recoveryOrderId, 'reintentar la misma clave recupera el pedido existente');
  assert.equal(replayRecoveryBody.replayed, true);
  assert.equal(await inventory.reservation.count({ where: { orderId: recoveryOrderId } }), 1);
  assert.equal(await payments.payment.count({ where: { orderId: recoveryOrderId } }), 1);
  console.log('Recuperación E2E aprobada: Pedido reinicia con order.created pendiente, publica desde outbox y confirma una sola vez sin cargo/reserva duplicados.');

  // Deja el mensaje persistente en la cola durable de Inventario sin consumer,
  // reinicia el broker efímero y comprueba que se entrega y liquida una sola vez.
  const brokerRecoveryBuyerId = '10000000-0000-4000-8000-000000000006';
  await payments.wallet.create({ data: { buyerId: brokerRecoveryBuyerId, balance: 5000, currency: 'COP' } });
  const inventoryPort = appPorts[required.indexOf('inventory-service')];
  const inventoryDatabaseUrl = urls[required.indexOf('inventory-service')];
  const inventoryReadyUrl = `${baseUrls['inventory-service']}/health/ready`;
  await stopService('inventory-service');

  const brokerRecoveryIdempotencyKey = `e2e-broker-restart-${suffix}`;
  const brokerRecoveryCheckout = await fetch(`${orderUrl}/api/v1/orders/checkout/async`, {
    method: 'POST', headers: buyerHeaders(brokerRecoveryBuyerId),
    body: JSON.stringify({ buyerId: brokerRecoveryBuyerId, deliveryAddress: 'Dirección E2E recuperación RabbitMQ', items: [{ productId: productIds[1], quantity: 2 }], currency: 'COP', idempotencyKey: brokerRecoveryIdempotencyKey }),
  });
  if (brokerRecoveryCheckout.status !== 201) throw new Error(`Checkout antes del reinicio RabbitMQ HTTP ${brokerRecoveryCheckout.status}: ${await brokerRecoveryCheckout.text()}`);
  const brokerRecoveryBody = await brokerRecoveryCheckout.json();
  const brokerRecoveryOrderId = brokerRecoveryBody?.order?.id;
  assert.ok(brokerRecoveryOrderId, 'el checkout debe persistir antes del reinicio RabbitMQ');
  assert.equal(brokerRecoveryBody.order.status, 'pending');
  const brokerRecoveryEvent = await orders.outboxEvent.findFirst({ where: { eventType: 'order.created', aggregateId: brokerRecoveryOrderId } });
  assert.ok(brokerRecoveryEvent, 'el pedido debe tener su evento order.created durable');
  await waitFor(async () => {
    const event = await orders.outboxEvent.findUnique({ where: { id: brokerRecoveryEvent.id } });
    const queue = await rabbitMonitorChannel.checkQueue('inventory-service.checkout');
    return event?.status === 'published' && queue.messageCount === 1 ? true : null;
  }, 'order.created persistido en la cola durable sin consumer');
  assert.equal(await inventory.reservation.count({ where: { orderId: brokerRecoveryOrderId } }), 0);
  assert.equal(await payments.payment.count({ where: { orderId: brokerRecoveryOrderId } }), 0);

  await rabbitMonitorChannel.close();
  rabbitMonitorChannel = undefined;
  await rabbitMonitor.close();
  rabbitMonitor = undefined;
  run('docker', ['restart', '--time', '5', rabbitContainerName]);
  await waitForPort(rabbitPort, 'RabbitMQ reiniciado');
  await openRabbitMonitor();
  assert.equal((await rabbitMonitorChannel.checkQueue('inventory-service.checkout')).messageCount, 1, 'RabbitMQ conserva order.created persistente tras reiniciarse');

  const orderReadyUrlAfterBroker = `${baseUrls['order-service']}/api/v1/health/ready`;
  const paymentReadyUrl = `${baseUrls['payment-service']}/api/v1/health/ready`;
  await Promise.all([
    waitForReady(orderReadyUrlAfterBroker, 'order-service reconectado a RabbitMQ'),
    waitForReady(paymentReadyUrl, 'payment-service reconectado a RabbitMQ'),
    waitForReady(logisticsReadyUrl, 'logistics-service reconectado a RabbitMQ'),
  ]);
  startService('inventory-service', inventoryPort, inventoryDatabaseUrl);
  await waitForReady(inventoryReadyUrl, 'inventory-service reconectado a RabbitMQ');

  const brokerRecoveredOrder = await waitForOrder(orderUrl, brokerRecoveryOrderId, buyerHeaders(brokerRecoveryBuyerId), 'confirmed');
  assert.equal(brokerRecoveredOrder.deliveryAddress, 'Dirección E2E recuperación RabbitMQ');
  assert.equal(await inventory.reservation.count({ where: { orderId: brokerRecoveryOrderId, status: 'consumed' } }), 1, 'mensaje recuperado genera solo una reserva consumida');
  assert.equal(await payments.payment.count({ where: { orderId: brokerRecoveryOrderId, status: 'authorized' } }), 1, 'mensaje recuperado genera solo un pago autorizado');
  assert.equal(Number((await payments.wallet.findUnique({ where: { buyerId: brokerRecoveryBuyerId } })).balance), 4500, 'la recuperación no duplica el débito');
  const replayBrokerRecovery = await fetch(`${orderUrl}/api/v1/orders/checkout/async`, {
    method: 'POST', headers: buyerHeaders(brokerRecoveryBuyerId),
    body: JSON.stringify({ buyerId: brokerRecoveryBuyerId, deliveryAddress: 'Dirección E2E recuperación RabbitMQ', items: [{ productId: productIds[1], quantity: 2 }], currency: 'COP', idempotencyKey: brokerRecoveryIdempotencyKey }),
  });
  assert.equal(replayBrokerRecovery.status, 201);
  const replayBrokerRecoveryBody = await replayBrokerRecovery.json();
  assert.equal(replayBrokerRecoveryBody.order.id, brokerRecoveryOrderId);
  assert.equal(replayBrokerRecoveryBody.replayed, true);
  assert.equal(await inventory.reservation.count({ where: { orderId: brokerRecoveryOrderId } }), 1);
  assert.equal(await payments.payment.count({ where: { orderId: brokerRecoveryOrderId } }), 1);
  console.log('Recuperación RabbitMQ E2E aprobada: order.created sobrevivió reinicio de broker y produjo una sola reserva, autorización y transacción TerraWallet.');

  console.log('Checkout E2E aprobado: POST HTTP real, pedido confirmado, cargo/detalle con comisión 10%, débito TerraWallet y consumo de inventario.');
  console.log('Compensación E2E aprobada: saldo insuficiente cancela el pedido, no debita ni crea pago y libera inventario.');
  console.log('Concurrencia E2E aprobada: dos compradores compiten por la última unidad y solo una reserva se confirma.');
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 1;
} finally {
  await Promise.allSettled(clients.map((client) => client.$disconnect()));
  if (responseDropServer) await new Promise((resolve) => responseDropServer.close(resolve));
  if (catalogServer) await new Promise((resolve) => catalogServer.close(resolve));
  await rabbitMonitorChannel?.close().catch(() => undefined);
  await rabbitMonitor?.close().catch(() => undefined);
  for (const child of children) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const name of containers.reverse()) {
    try { run('docker', ['stop', '--time', '3', name]); }
    catch (error) { console.error(`No se pudo detener el contenedor temporal ${name}: ${error.message}`); process.exitCode = 1; }
  }
}
