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
let browser;
async function webPage(token, userId, roles, section) {
  if (!process.env.FTT_PLAYWRIGHT_MODULE) return null;
  if (!browser) {
    const { chromium } = prismaRequire(process.env.FTT_PLAYWRIGHT_MODULE);
    browser = await chromium.launch({ channel: 'msedge', headless: true });
  }
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ token, userId, roles }) => {
    sessionStorage.setItem('ftt_token', token);
    sessionStorage.setItem('ftt_user', userId);
    sessionStorage.setItem('ftt_roles', JSON.stringify(roles));
  }, { token, userId, roles });
  await page.goto(`${baseUrl}#/${section}`);
  await page.getByRole('heading', { name: section === 'entregas' ? 'Mis entregas' : 'Logística y rutas', exact: true }).waitFor();
  return { page, context, errors };
}

async function request(route, { base = baseUrl, method = 'GET', token, body, timeoutMs = 15_000, operationId = randomUUID() } = {}) {
  const response = await fetch(new URL(route, base), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      'x-correlation-id': correlationId,
      'idempotency-key': operationId,
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
  const card = await expectStatus(`/api/v1/payments/cards/${buyerId}`, { method: 'POST', token: buyerToken, body: { brand: 'Visa', holderName: buyerName } }, 201);
  await expectStatus(`/api/v1/payments/wallet/${buyerId}/top-up`, {
    method: 'POST', token: adminToken, body: { amount: 100_000, reason: 'Fondos de prueba E2E local', idempotencyKey: `local-test:${suffix}` },
  }, 201);
  const initialWallet = await expectStatus(`/api/v1/payments/wallet/${buyerId}`, { token: buyerToken }, 200);
  assert.ok(Number(initialWallet.balance) >= 100_000, `Saldo inicial inesperado: ${JSON.stringify(initialWallet)}`);

  const checkout = await expectStatus('/api/v1/orders/checkout/async', {
    method: 'POST', token: buyerToken, timeoutMs: 60_000,
    body: {
      buyerId, simulatedCardId: card.id, deliveryAddress: 'Calle de prueba 123, Medellín', currency: 'COP',
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

  const logisticsResults = [];
  if (process.env.FTT_TEST_LOGISTICS === '1') {
    const driverEmail = `local-driver-${suffix}@example.test`;
    const driverUser = await registerAndVerify(driverEmail, 'Transportista E2E');
    await expectStatus(`/api/v1/identity/auth/users/${driverUser.id}/roles`, { method: 'PATCH', token: adminToken, body: { roles: ['driver'] } }, 200);
    const driverToken = (await login(driverEmail)).access_token;
    const driver = await expectStatus('/api/v1/drivers', { method: 'POST', token: adminToken, body: { userId: driverUser.id, fullName: 'Transportista E2E', phone: '+573001234567', licenseNumber: suffix } }, 201);
    const vehicle = await expectStatus('/api/v1/vehicles', { method: 'POST', token: adminToken, body: { plate: suffix.slice(0, 8), capacityKg: 100, refrigerated: true } }, 201);
    const zone = await expectStatus('/api/v1/logistics/zones', { method: 'POST', token: adminToken, body: { code: suffix.slice(0, 8), name: 'Zona de prueba local' } }, 201);
    const adminWeb = await webPage(adminToken, admin.user_id, ['admin'], 'logistica');
    if (adminWeb) {
      await adminWeb.page.getByRole('heading', { name: 'Planificar ruta', exact: true }).waitFor();
      assert.deepEqual(adminWeb.errors, [], 'La pantalla de administración no debe tener errores JS');
      await adminWeb.context.close();
    }
    async function poll(read, accept, label) {
      let latest;
      for (let i = 0; i < 80; i++) { latest = await read(); if (accept(latest)) return latest; await delay(500); }
      assert.fail(`${label}: ${JSON.stringify(latest)}`);
    }
    for (const [mode, acceptedKg, expectedOrder, expectedPayment] of [['completed', 2, 'delivered', 'captured'], ['partial', 1, 'partial', 'captured'], ['failed', 0, 'cancelled', 'voided']]) {
      let current = order;
      if (mode !== 'completed') {
        const next = await expectStatus('/api/v1/orders/checkout/async', { method: 'POST', token: buyerToken, timeoutMs: 60_000, body: { buyerId, simulatedCardId: card.id, deliveryAddress: 'PRUEBA LOCAL - sin despacho real', currency: 'COP', idempotencyKey: `${suffix}:${mode}`, items: [{ productId: product.id, quantity: 2 }] } }, 201);
        current = await poll(() => expectStatus(`/api/v1/orders/${next.order.id}`, { token: buyerToken }, 200), row => row.status === 'confirmed', 'Confirmación de pedido');
      }
      const delivery = await poll(() => expectStatus('/api/v1/deliveries', { token: buyerToken }, 200), rows => rows.some(d => d.orderId === current.id), 'Creación de plan').then(rows => rows.find(d => d.orderId === current.id));
      const start = new Date(delivery.windowStart).getTime();
      const origins = [...new Map(delivery.lots.map(l => [l.farmId, l])).values()];
      const stops = origins.map((l, i) => ({ deliveryId: delivery.id, sequence: i + 1, type: 'pickup', farmId: l.farmId, address: l.pickupAddress, plannedAt: new Date(start + i * 60000).toISOString() }));
      stops.push({ deliveryId: delivery.id, sequence: stops.length + 1, type: 'dropoff', address: delivery.deliveryAddress, plannedAt: new Date(start + 3600000).toISOString() });
      const route = await expectStatus('/api/v1/routes', { method: 'POST', token: adminToken, body: { driverId: driver.id, vehicleId: vehicle.id, zoneCode: zone.code, scheduledDate: new Date(start).toISOString(), scheduledEnd: new Date(start + 7200000).toISOString(), deliveryIds: [delivery.id], stops } }, 201);
      const receipt = { status: mode, reason: 'Recepción simulada de prueba local', acceptedLots: delivery.lots.map(l => ({ reservationId: l.reservationId, acceptedQuantityKg: acceptedKg })) };
      await expectStatus(`/api/v1/orders/${current.id}/status`, { method: 'PATCH', token: adminToken, body: { status: 'delivered' } }, 409);
      await expectStatus(`/api/v1/routes/${route.id}/dispatch`, { method: 'PATCH', token: buyerToken }, 403);
      await expectStatus(`/api/v1/routes/${route.id}/dispatch`, { method: 'PATCH', token: driverToken }, 200);
      await poll(() => expectStatus(`/api/v1/orders/${current.id}`, { token: buyerToken }, 200), o => o.status === 'dispatched', 'Pedido en tránsito');
      await expectStatus(`/api/v1/deliveries/${delivery.id}/confirm`, { method: 'PATCH', token: buyerToken, body: receipt }, 409);
      await expectStatus(`/api/v1/deliveries/${delivery.id}/confirm`, { method: 'PATCH', token: driverToken, body: receipt }, 403);
      if (mode !== 'failed') await expectStatus(`/api/v1/deliveries/${delivery.id}/close`, { method: 'PATCH', token: driverToken, body: receipt }, 403);
      if (route.stops.length > 1) await expectStatus(`/api/v1/routes/${route.id}/stops/${route.stops[1].id}/arrive`, { method: 'PATCH', token: driverToken }, 409);
      for (const stop of route.stops) await expectStatus(`/api/v1/routes/${route.id}/stops/${stop.id}/arrive`, { method: 'PATCH', token: driverToken }, 200);
      let op = randomUUID();
      const buyerWeb = mode === 'completed' ? await webPage(buyerToken, buyerId, ['buyer'], 'entregas') : null;
      if (buyerWeb) {
        const received = buyerWeb.page.waitForResponse(response => response.url().includes(`/deliveries/${delivery.id}/confirm`) && response.request().method() === 'PATCH');
        buyerWeb.page.once('dialog', dialog => dialog.accept());
        await buyerWeb.page.getByRole('button', { name: 'Guardar', exact: true }).click();
        const response = await received;
        assert.equal(response.status(), 200, 'El comprador debe poder confirmar la recepción desde la web');
        op = response.request().headers()['idempotency-key'];
        assert.deepEqual(buyerWeb.errors, [], 'La pantalla de recepción no debe tener errores JS');
        await buyerWeb.context.close();
      }
      const closeOptions = { method: 'PATCH', token: mode === 'failed' ? driverToken : buyerToken, body: receipt, operationId: op };
      const path = `/api/v1/deliveries/${delivery.id}/${mode === 'failed' ? 'close' : 'confirm'}`;
      if (!buyerWeb) await expectStatus(path, closeOptions, 200);
      await expectStatus(path, closeOptions, 200); // replay must not capture twice
      const closedOrder = await poll(() => expectStatus(`/api/v1/orders/${current.id}`, { token: buyerToken }, 200), o => o.status === expectedOrder, 'Cierre del pedido');
      if (order.id === closedOrder.id) order = closedOrder;
      const payment = await poll(() => expectStatus(`/api/v1/payments/by-order/${current.id}`, { token: buyerToken }, 200), p => p.status === expectedPayment, 'Liquidación real del simulador');
      assert.equal(Number(payment.capturedAmount), acceptedKg * 1000);
      const routesAfter = await expectStatus('/api/v1/routes', { token: driverToken }, 200);
      assert.equal(routesAfter.find(r => r.id === route.id)?.status, 'completed');
      logisticsResults.push({ scenario: mode, order: expectedOrder, payment: expectedPayment, captured: Number(payment.capturedAmount), replay: 'PASS' });
    }
    const settledWallet = await expectStatus(`/api/v1/payments/wallet/${buyerId}`, { token: buyerToken }, 200);
    assert.equal(Number(settledWallet.balance), Number(initialWallet.balance) - 3000, 'Solo deben cobrarse 3 kg aceptados entre las tres compras');
    const notices = await poll(() => expectStatus('/api/v1/notifications/me', { token: buyerToken }, 200), rows => rows.some(n => n.type === 'delivery.arrived'), 'Aviso de llegada al comprador');
    assert.ok(notices.some(n => n.type === 'delivery.in_transit'));
  }

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
    logistics_results: logisticsResults,
    browser_ui: process.env.FTT_PLAYWRIGHT_MODULE ? 'PASS' : 'not_run',
    local_test_records_persist: true,
  }, null, 2));
} finally {
  await browser?.close();
  await prisma.$disconnect();
}
