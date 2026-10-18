import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import exec from 'k6/execution';
import { Counter, Rate, Trend } from 'k6/metrics';

const BASE_URL = String(__ENV.BASE_URL ?? '').replace(/\/$/, '');
const PRODUCTION_BASE_URL = String(__ENV.PRODUCTION_BASE_URL ?? '').replace(/\/$/, '');
const TEST_RUN_ID = __ENV.TEST_RUN_ID || `k6-${Date.now()}`;
const ordersCreated = new Counter('orders_created');
const ordersConfirmed = new Counter('orders_confirmed');
const orderOutcome = new Rate('order_outcome');
const loadOrderCount = new Counter('load_order_samples');
const orderConfirmationMs = new Trend('order_confirmation_ms', true);

function validateLoadTarget() {
  if (__ENV.TARGET_ENV !== 'staging' || __ENV.ALLOW_STAGING_LOAD_TEST !== 'true') {
    throw new Error('Carga cancelada: define TARGET_ENV=staging y ALLOW_STAGING_LOAD_TEST=true solo para un staging aislado.');
  }
  const baseOrigin = normalizeHttpsOrigin(BASE_URL);
  const productionOrigin = normalizeHttpsOrigin(PRODUCTION_BASE_URL);
  if (!baseOrigin || !productionOrigin || baseOrigin === productionOrigin) {
    throw new Error('BASE_URL y PRODUCTION_BASE_URL deben ser HTTPS y distintos, y apuntar a la raíz de cada origen.');
  }
}

// k6 no incluye el constructor WHATWG URL en el runtime extendido. Acepta solo
// orígenes HTTPS (con una barra opcional) y normaliza host/mayúsculas/puerto 443
// antes de comparar para que una ruta distinta no pueda ocultar producción.
function normalizeHttpsOrigin(value) {
  const match = /^https:\/\/([^/?#]+)\/?$/i.exec(value);
  if (!match) return null;
  const authority = match[1].toLowerCase();
  if (authority.includes('@')) return null;

  let hostname; let port = '';
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end < 0) return null;
    hostname = authority.slice(0, end + 1);
    const suffix = authority.slice(end + 1);
    if (suffix && !/^:\\d+$/.test(suffix)) return null;
    port = suffix.slice(1);
    if (!/^\[[0-9a-f:.]+\]$/i.test(hostname)) return null;
  } else {
    const colon = authority.lastIndexOf(':');
    hostname = colon >= 0 ? authority.slice(0, colon) : authority;
    port = colon >= 0 ? authority.slice(colon + 1) : '';
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(hostname)) return null;
  }
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return null;
  if (port && Number(port) === 443) port = '';
  if (!hostname.startsWith('[') && hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  return `https://${hostname}${port ? `:${port}` : ''}`;
}

const stages = [
  { duration: '1m', target: 0.2 },
  { duration: '3m', target: 0.2 },
  { duration: '2m', target: 1 },
  { duration: '5m', target: 1 },
  { duration: '1m', target: 0 },
];
const weightedStages = (weight) => stages.map((stage) => ({
  duration: stage.duration,
  target: Math.round(stage.target * 100 * weight),
}));

export const options = {
  setupTimeout: '3m',
  teardownTimeout: '5m',
  scenarios: {
    catalog: { executor: 'ramping-vus', startVUs: 0, stages: weightedStages(0.7), gracefulRampDown: '30s' },
    cart: { executor: 'ramping-vus', startVUs: 0, stages: weightedStages(0.2), gracefulRampDown: '30s' },
    orders: { executor: 'ramping-vus', startVUs: 0, stages: weightedStages(0.1), gracefulRampDown: '35s' },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{scenario:catalog}': ['p(95)<500'],
    'http_req_duration{scenario:orders}': ['p(95)<1500'],
    'order_confirmation_ms{scenario:orders}': ['p(95)<5000'],
    'order_outcome{scenario:orders}': ['rate==1'],
    load_order_samples: ['count>=100'],
  },
};

function api(path, token, params = {}) {
  return http.request('GET', `${BASE_URL}${path}`, null, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    tags: params.tags,
    timeout: params.timeout ?? '10s',
  });
}

function currentAccessToken(buyer) {
  if (Date.now() < buyer.accessExpiresAt - 60_000) return buyer.accessToken;
  const response = http.post(`${BASE_URL}/api/v1/identity/auth/refresh`, JSON.stringify({ refresh_token: buyer.refreshToken }), {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    tags: { phase: 'session_refresh' },
    timeout: '10s',
  });
  let session;
  try { session = response.json(); } catch { session = null; }
  if ((response.status !== 200 && response.status !== 201) || !session?.access_token || !session?.refresh_token) {
    return null;
  }
  buyer.accessToken = session.access_token;
  buyer.refreshToken = session.refresh_token;
  buyer.accessExpiresAt = Date.now() + Number(session.expires_in ?? 900) * 1000;
  return buyer.accessToken;
}

function revokeSessions(users) {
  for (const buyer of users) {
    if (!buyer.refreshToken) continue;
    const accessToken = currentAccessToken(buyer);
    if (!accessToken) continue;
    http.post(`${BASE_URL}/api/v1/identity/auth/logout`, JSON.stringify({ refresh_token: buyer.refreshToken }), {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      tags: { phase: 'teardown' }, timeout: '10s',
    });
  }
}

export function setup() {
  // Mantener la validación antes de cualquier solicitud y dentro de setup:
  // `k6 inspect` puede analizar el script sin requerir secretos de staging.
  validateLoadTarget();
  let buyers;
  try {
    buyers = JSON.parse(__ENV.K6_BUYERS_JSON || '[]');
  } catch {
    throw new Error('K6_BUYERS_JSON debe ser JSON válido; nunca se imprime su contenido.');
  }
  if (!Array.isArray(buyers) || buyers.length < 200) {
    throw new Error('Prepara 200 cuentas sintéticas buyer: 100 dedicadas a pedidos y lectura de catálogo, y otras 100 para carritos.');
  }
  const users = [];
  try {
    for (const buyer of buyers) {
      if (!buyer?.email || !buyer?.password || !buyer?.productId || !buyer?.deliveryAddress || !(Number(buyer.quantity) > 0)) {
        throw new Error('Cada comprador sintético requiere email, password, productId, quantity y deliveryAddress.');
      }
      const response = http.post(`${BASE_URL}/api/v1/identity/auth/login`, JSON.stringify({
        email: buyer.email,
        password: buyer.password,
        device_name: `k6-staging-${TEST_RUN_ID}`,
      }), {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        tags: { phase: 'setup' },
        timeout: '15s',
      });
      if (response.status !== 201 && response.status !== 200) {
        throw new Error(`No se pudo autenticar una cuenta sintética para la prueba (HTTP ${response.status}); se aborta antes de generar carga.`);
      }
      let session;
      try { session = response.json(); } catch { session = null; }
      if (!session?.access_token || !session?.refresh_token || !session?.user?.id || !session.user.roles?.includes('buyer')) {
        throw new Error('La cuenta sintética no devolvió sesión buyer válida; se aborta antes de generar carga.');
      }
      users.push({
        buyerId: session.user.id,
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
        accessExpiresAt: Date.now() + Number(session.expires_in ?? 900) * 1000,
        productId: buyer.productId,
        quantity: Number(buyer.quantity),
        deliveryAddress: buyer.deliveryAddress,
      });
    }
  } catch (error) {
    revokeSessions(users);
    throw error;
  }
  return { users };
}

const loadOrderIds = [];

export default function (data) {
  const vuIndex = exec.vu.idInTest - 1;
  if (exec.scenario.name === 'catalog') {
    const buyer = data.users[vuIndex];
    const token = currentAccessToken(buyer);
    if (!token) fail('No se pudo renovar una sesión sintética; se detiene esta iteración.');
    const response = api('/api/v1/catalog/products/available?available=true&page=1&limit=20', token, { tags: { scenario: 'catalog' } });
    check(response, {
      'catálogo responde 200': (res) => res.status === 200,
      'catálogo devuelve estructura paginada': (res) => {
        try { const body = res.json(); return Array.isArray(body?.data) && Boolean(body?.meta); } catch { return false; }
      },
    });
    sleep(1);
    return;
  }

  if (exec.scenario.name === 'cart') {
    const buyer = data.users[100 + vuIndex];
    const token = currentAccessToken(buyer);
    if (!token) fail('No se pudo renovar una sesión sintética; se detiene esta iteración.');
    const auth = `Bearer ${token}`;
    const headers = { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (__ITER % 2 === 0) {
      const read = http.get(`${BASE_URL}/api/v1/orders/cart/${buyer.buyerId}`, { headers, tags: { scenario: 'cart' }, timeout: '10s' });
      check(read, { 'carrito consulta responde 200': (res) => res.status === 200 });
    } else {
      const write = http.put(`${BASE_URL}/api/v1/orders/cart/${buyer.buyerId}`, JSON.stringify({
        items: [{ productId: buyer.productId, quantity: buyer.quantity }],
      }), { headers, tags: { scenario: 'cart' }, timeout: '10s' });
      check(write, { 'carrito guarda responde 200': (res) => res.status === 200 || res.status === 201 });
    }
    sleep(1);
    return;
  }

  if (exec.scenario.name === 'orders') {
    const sampleIndex = __ITER % 10;
    const orderBuyer = data.users[vuIndex];
    const accessToken = currentAccessToken(orderBuyer);
    if (!accessToken) fail('No se pudo renovar una sesión sintética; se detiene esta iteración.');
    const auth = `Bearer ${accessToken}`;
    const orderId = loadOrderIds[sampleIndex];
    if (__ITER < 10) {
      const startedAt = Date.now();
      const response = http.post(`${BASE_URL}/api/v1/orders/checkout/async`, JSON.stringify({
        buyerId: orderBuyer.buyerId,
        deliveryAddress: orderBuyer.deliveryAddress,
        currency: 'COP',
        idempotencyKey: `${TEST_RUN_ID}-${__VU}-${__ITER}`,
        items: [{ productId: orderBuyer.productId, quantity: orderBuyer.quantity }],
      }), {
        headers: { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' },
        tags: { scenario: 'orders' },
        timeout: '15s',
      });
      if (!check(response, { 'pedido aceptado para procesar': (res) => res.status === 201 })) {
        orderOutcome.add(false, { scenario: 'orders' });
        fail(`El checkout de staging no fue aceptado (HTTP ${response.status}); revisar fixture y detener la prueba.`);
      }
      let body;
      try { body = response.json(); } catch { body = null; }
      const createdOrderId = body?.order?.id;
      if (!createdOrderId) {
        orderOutcome.add(false, { scenario: 'orders' });
        fail('Checkout no devolvió order.id; no se continuará con carga inválida.');
      }
      ordersCreated.add(1, { scenario: 'orders' });
      loadOrderCount.add(1, { scenario: 'orders' });
      loadOrderIds[sampleIndex] = createdOrderId;

      const deadline = Date.now() + 30_000;
      let order;
      while (Date.now() < deadline) {
        const current = api(`/api/v1/orders/${createdOrderId}`, accessToken, { tags: { scenario: 'orders' }, timeout: '10s' });
        if (current.status !== 200) {
          orderOutcome.add(false, { scenario: 'orders' });
          fail(`No se pudo consultar el pedido creado (HTTP ${current.status}).`);
        }
        try { order = current.json(); } catch { order = null; }
        if (order?.status === 'confirmed') break;
        if (order?.status === 'cancelled') {
          orderOutcome.add(false, { scenario: 'orders' });
          fail('El pedido de capacidad se canceló; revisar saldo/stock de staging.');
        }
        sleep(0.25);
      }
      const elapsed = Date.now() - startedAt;
      if (order?.status !== 'confirmed') {
        orderOutcome.add(false, { scenario: 'orders' });
        fail('Un pedido quedó pendiente más de 30 s; falló el drenaje de la saga.');
      }
      orderConfirmationMs.add(elapsed, { scenario: 'orders' });
      ordersConfirmed.add(1, { scenario: 'orders' });
      orderOutcome.add(true, { scenario: 'orders' });
      check(order, { 'pedido confirmó saga': (value) => value?.status === 'confirmed' });
    } else {
      const response = api(`/api/v1/orders/${orderId}`, accessToken, { tags: { scenario: 'orders' }, timeout: '10s' });
      const ok = check(response, { 'consulta de pedido responde 200': (res) => res.status === 200 });
      if (!ok) orderOutcome.add(false, { scenario: 'orders' });
    }
    sleep(1);
  }
}

export function teardown(data) {
  // Revoca las sesiones creadas en setup. La solicitud va después de la carga
  // para no contaminar los umbrales de los escenarios.
  revokeSessions(data.users);
}

export function handleSummary(data) {
  const created = data.metrics.orders_created?.values?.count ?? 0;
  const confirmed = data.metrics.orders_confirmed?.values?.count ?? 0;
  if (created !== confirmed) {
    console.error(`Invariante fallida: pedidos iniciados=${created}, confirmados=${confirmed}.`);
  }
  return {
    [__ENV.K6_SUMMARY_PATH || 'artifacts/k6-summary.json']: JSON.stringify({ ...data, invariants: { ordersCreated: created, ordersConfirmed: confirmed, allOrdersConfirmed: created === confirmed } }, null, 2),
  };
}
