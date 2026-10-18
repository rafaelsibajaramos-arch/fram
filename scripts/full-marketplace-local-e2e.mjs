import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// Esta prueba escribe datos persistentes, pero solo en el stack Compose local.
// Las dos barreras siguientes impiden apuntarla a una URL remota o a otra DB.
const baseUrl = new URL(process.env.FTT_LOCAL_URL ?? 'http://127.0.0.1:14000');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)) {
  throw new Error('Prueba cancelada: FTT_LOCAL_URL debe apuntar a loopback.');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const inspect = JSON.parse(execFileSync('docker', ['inspect', 'farmtotable-local-postgres-identity'], { encoding: 'utf8' }))[0];
const bindings = inspect?.NetworkSettings?.Ports?.['5432/tcp'] ?? [];
if (!bindings.some((binding) => binding.HostIp === '127.0.0.1' && binding.HostPort === '15433')) {
  throw new Error('Prueba cancelada: el contenedor Identity no coincide con la base local aislada esperada.');
}
const dbUrl = 'postgresql://farmtotable:farmtotable_local_only@127.0.0.1:15433/identity_db?schema=public';
const prismaRequire = createRequire(path.join(root, 'identity-service', 'package.json'));
const { PrismaClient } = prismaRequire('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
const suffix = randomUUID();
const password = `LocalOnly-${randomUUID()}-Aa9!`;
const adminEmail = `local-admin-${suffix}@example.test`;
const producerEmail = `local-producer-${suffix}@example.test`;
const buyerEmail = `local-buyer-${suffix}@example.test`;
const adminName = `Admin E2E ${suffix.slice(0, 8)}`;
const producerName = `Productor E2E ${suffix.slice(0, 8)}`;
const buyerName = `Comprador E2E ${suffix.slice(0, 8)}`;
const correlationId = randomUUID();

async function request(route, { base = baseUrl, method = 'GET', token, body, timeoutMs = 15_000 } = {}) {
  const response = await fetch(new URL(route, base), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      'x-correlation-id': correlationId,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return { status: response.status, data };
}

async function expectStatus(route, options, status) {
  const result = await request(route, options);
  assert.equal(result.status, status, `${options?.method ?? 'GET'} ${route}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function registerAndVerify(email, fullName) {
  const registration = await expectStatus('/api/v1/identity/auth/register', {
    method: 'POST', body: { email, password, full_name: fullName },
  }, 201);
  assert.ok(registration.verification_token, 'Identity local debe exponer el token de verificación');
  const verified = await expectStatus('/api/v1/identity/auth/email/verify', {
    method: 'POST', body: { token: registration.verification_token },
  }, 201);
  return verified;
}

async function login(email) {
  return expectStatus('/api/v1/identity/auth/login', {
    method: 'POST', body: { email, password, device_name: 'Full marketplace E2E local' },
  }, 201);
}

try {
  const health = await expectStatus('/api/v1/system/health', undefined, 200);
  for (const name of ['producer-service', 'catalog-service', 'identity-service', 'inventory-service', 'order-service', 'payment-service']) {
    assert.equal(health[name]?.listo, true, `${name} debe estar ready antes de probar compra`);
  }

  await registerAndVerify(adminEmail, adminName);
  // Semilla exclusiva de esta prueba: se promociona el usuario local de prueba
  // antes de iniciar sesión, sin tocar sesiones ni cuentas preexistentes.
  await prisma.user.update({ where: { email: adminEmail }, data: { roles: ['admin'], rolesVersion: { increment: 1 }, version: { increment: 1 } } });
  const admin = await login(adminEmail);
  const adminToken = admin.access_token;
  assert.ok(adminToken);

  const producerUser = await registerAndVerify(producerEmail, producerName);
  const producerApplication = await expectStatus('/api/v1/identity/auth/producer-applications', {
    method: 'POST', token: (await login(producerEmail)).access_token,
    body: { business_name: `Finca E2E ${suffix.slice(0, 8)}`, phone: '+573001234567', message: 'Prueba integral local.' },
  }, 201);
  assert.equal(producerApplication.status, 'pending');
  const applicationReview = await expectStatus(`/api/v1/identity/auth/producer-applications/${producerApplication.id}`, {
    method: 'PATCH', token: adminToken,
    body: { decision: 'approved', review_notes: 'Aprobación de fixture E2E local.' },
  }, 200);
  assert.ok(applicationReview.applicant.roles.includes('producer'));
  const producer = await login(producerEmail);
  const producerToken = producer.access_token;
  assert.ok(producerToken);

  const producerProfile = await expectStatus('/api/v1/producer/producers', {
    method: 'POST', token: producerToken,
    body: { user_id: producerUser.id, full_name: producerName, email: producerEmail, phone: '+573001234567' },
  }, 201);
  const farm = await expectStatus(`/api/v1/producer/producers/${producerProfile.id}/farms`, {
    method: 'POST', token: producerToken,
    body: { farm_name: `Finca local ${suffix.slice(0, 8)}`, address: 'Vereda de pruebas, Antioquia', latitude: 6.2442, longitude: -75.5812 },
  }, 201);
  const category = await expectStatus('/api/v1/catalog/categories', {
    method: 'POST', token: adminToken, body: { name: `E2E ${suffix.slice(0, 8)}` },
  }, 201);
  const product = await expectStatus('/api/v1/catalog/products', {
    method: 'POST', token: producerToken,
    body: {
      producer_id: producerProfile.id, name: `Tomate E2E ${suffix.slice(0, 8)}`,
      category_id: category.id, unit: 'kg', min_order_quantity: 1,
      base_price: 1000, low_stock_threshold: 5, high_stock_threshold: 100,
    },
  }, 201);
  const harvestDate = new Date().toISOString().slice(0, 10);
  const expiryDate = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const harvest = await expectStatus('/api/v1/catalog/harvest-batches', {
    method: 'POST', token: producerToken,
    body: { product_id: product.id, farm_id: farm.id, harvest_date: harvestDate, quantity_kg: 25, expiry_estimate: expiryDate },
  }, 201);
  const published = await expectStatus(`/api/v1/catalog/harvest-batches/${harvest.batch_id}/publish`, {
    method: 'PATCH', token: producerToken,
  }, 200);
  assert.equal(published.status, 'published');

  let stock;
  let lastStockResponse;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    // El gateway no publica el prefijo interno /inventory dos veces; consultar
    // el endpoint REST del servicio directamente evita confundir su montaje.
    const result = await request(`/inventory/products/${product.id}`, { base: 'http://127.0.0.1:13104', token: adminToken });
    lastStockResponse = result;
    if (result.status === 200 && Array.isArray(result.data)) {
      stock = result.data.find((item) => item.batch_id === harvest.batch_id && Number(item.available_kg) >= 25);
      if (stock) break;
    }
    await delay(500);
  }
  assert.ok(stock, `harvest.registered debe llegar a Inventory y crear stock disponible; respuesta=${JSON.stringify(lastStockResponse)}`);
  assert.equal(Number(stock.available_kg), 25);

  const buyerUser = await registerAndVerify(buyerEmail, buyerName);
  const buyer = await login(buyerEmail);
  const buyerToken = buyer.access_token;
  const buyerId = buyerUser.id;
  await expectStatus(`/api/v1/payments/wallet/${buyerId}/top-up`, {
    method: 'POST', token: adminToken, body: { amount: 100_000, reason: 'Fondos de prueba E2E local', idempotencyKey: `local-test:${suffix}` },
  }, 201);
  const initialWallet = await expectStatus(`/api/v1/payments/wallet/${buyerId}`, { token: buyerToken }, 200);
  assert.ok(Number(initialWallet.balance) >= 100_000, `Saldo inicial inesperado: ${JSON.stringify(initialWallet)}`);

  const checkout = await expectStatus('/api/v1/orders/checkout/async', {
    method: 'POST', token: buyerToken, timeoutMs: 60_000,
    body: {
      buyerId, deliveryAddress: 'Calle de prueba 123, Medellín', currency: 'COP',
      idempotencyKey: `full-local-e2e:${suffix}`,
      items: [{ productId: product.id, quantity: 2 }],
    },
  }, 201);
  assert.ok(checkout.order?.id, `Checkout saga debe devolver un pedido: ${JSON.stringify(checkout)}`);
  let order = checkout.order;
  const checkoutDeadline = Date.now() + 30_000;
  while (order.status === 'pending' && Date.now() < checkoutDeadline) {
    await delay(300);
    order = await expectStatus(`/api/v1/orders/${checkout.order.id}`, { token: buyerToken }, 200);
  }
  assert.equal(order.status, 'confirmed');
  assert.equal(order.buyerId, buyerId);
  assert.equal(order.deliveryAddress, 'Calle de prueba 123, Medellín');
  assert.equal(order.items?.[0]?.productName, product.name);
  assert.equal(order.items?.[0]?.producerName, producerName);
  assert.equal(Number(order.totalAmount), 2000);

  const buyerOrders = await expectStatus('/api/v1/orders', { token: buyerToken }, 200);
  assert.ok(buyerOrders.some((row) => row.id === order.id));
  const buyerDetail = await expectStatus(`/api/v1/orders/${order.id}`, { token: buyerToken }, 200);
  assert.equal(buyerDetail.deliveryAddress, order.deliveryAddress);
  assert.equal(buyerDetail.items?.[0]?.productName, product.name);
  const adminOrders = await expectStatus('/api/v1/orders', { token: adminToken }, 200);
  assert.ok(adminOrders.some((row) => row.id === order.id));
  const adminDetail = await expectStatus(`/api/v1/orders/${order.id}`, { token: adminToken }, 200);
  assert.equal(adminDetail.deliveryAddress, order.deliveryAddress);
  const producerOrders = await expectStatus('/api/v1/orders', { token: producerToken }, 200);
  assert.ok(producerOrders.some((row) => row.id === order.id));
  const producerDetail = await expectStatus(`/api/v1/orders/${order.id}`, { token: producerToken }, 200);
  assert.equal(producerDetail.deliveryAddress, order.deliveryAddress);
  assert.equal(producerDetail.items?.[0]?.producerName, producerName);

  const finalWallet = await expectStatus(`/api/v1/payments/wallet/${buyerId}`, { token: buyerToken }, 200);
  assert.equal(Number(finalWallet.balance), Number(initialWallet.balance) - 2000);
  const paymentList = await expectStatus('/api/v1/payments', { token: adminToken }, 200);
  assert.ok(paymentList.some((payment) => payment.orderId === order.id));
  const finalStock = await expectStatus(`/inventory/products/${product.id}`, { base: 'http://127.0.0.1:13104', token: adminToken }, 200);
  assert.equal(Number(finalStock.find((item) => item.batch_id === harvest.batch_id)?.available_kg), 23);

  console.log(JSON.stringify({
    result: 'PASS',
    order_id: order.id,
    order_status: order.status,
    amount_cop: Number(order.totalAmount),
    product_name: product.name,
    producer_name: producerName,
    address: order.deliveryAddress,
    buyer_admin_producer_visibility: 'PASS',
    wallet_debit_and_stock_consumption: 'PASS',
    local_test_records_persist: true,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
