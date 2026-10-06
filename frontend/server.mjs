/**
 * FarmToTable - API Gateway + interfaz web.
 *
 * Cumple tres papeles que en la arquitectura completa serian piezas aparte:
 *
 *  1. API Gateway     - unico punto publico, rate limiting, timeouts,
 *                       correlation_id y enrutado hacia los dos microservicios.
 *  2. Identidad (mock)- emite el JWT que los servicios verifican. El
 *                       microservicio real de Identidad no esta en este alcance.
 *  3. Inventario (mock)- publica inventory.stock_changed en RabbitMQ para poder
 *                       demostrar el precio dinamico sin tener inventory-service.
 *
 * El navegador solo habla con este gateway, nunca con 3001/3002 directamente.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import amqp from 'amqplib';

const aqui = dirname(fileURLToPath(import.meta.url));
config({ path: join(aqui, '..', '.env') });
config({ path: join(aqui, '.env') });

const PORT = parseInt(process.env.GATEWAY_PORT ?? '4000', 10);
const PRODUCER_URL = (process.env.PRODUCER_SERVICE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const CATALOG_URL = (process.env.CATALOG_SERVICE_URL ?? 'http://localhost:3002').replace(/\/+$/, '');
const IDENTITY_URL = (process.env.IDENTITY_SERVICE_URL ?? 'http://localhost:3003').replace(/\/+$/, '');
const INVENTORY_URL = (process.env.INVENTORY_SERVICE_URL ?? 'http://localhost:3004').replace(/\/+$/, '');
const ORDER_URL = (process.env.ORDER_SERVICE_URL ?? 'http://localhost:3005').replace(/\/+$/, '');
const PAYMENT_URL = (process.env.PAYMENT_SERVICE_URL ?? 'http://localhost:3006').replace(/\/+$/, '');
const RABBIT_URL = process.env.RABBITMQ_URL ?? buildRabbitUrl();
const EXCHANGE = process.env.RABBITMQ_EXCHANGE ?? 'farmtotable.events';
const RABBIT_MGMT = process.env.RABBITMQ_MGMT_URL ?? 'http://localhost:15672';
// Checkout encadena validación de catálogo, reserva, pago y despacho. Diez
// segundos podía cortar una compra correcta en redes frías antes de que el
// servicio de pedidos terminara sus compensaciones acotadas.
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS ?? '30000', 10);

function buildRabbitUrl() {
  const u = process.env.RABBITMQ_USER ?? 'farmtotable';
  const p = process.env.RABBITMQ_PASS ?? 'farmtotable';
  const h = process.env.RABBITMQ_HOST ?? 'localhost';
  return `amqp://${u}:${p}@${h}:5672`;
}

const app = express();
app.disable('x-powered-by');
// Los documentos de certificación viajan como multipart hasta producer-service.
app.use(
  ['/api/producer', '/api/v1/producer'],
  express.raw({
    type: (req) => /^multipart\/form-data(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''),
    limit: '11mb',
  }),
);
app.use(express.json({ limit: '256kb' }));

// --------------------------------------------------------------- correlation
// Un solo correlation_id recorre gateway -> servicio -> evento -> consumidor.
app.use((req, res, next) => {
  req.correlationId = req.header('x-correlation-id') ?? randomUUID();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
});

// ------------------------------------------------------------- rate limiting
// Ventana deslizante simple en memoria. En produccion iria en el Gateway real.
const VENTANA_MS = 60_000;
const MAX_POR_VENTANA = parseInt(process.env.RATE_LIMIT ?? '300', 10);
const golpes = new Map();
const respuestasIdempotentes = new Map();

app.use('/api', (req, res, next) => {
  const ahora = Date.now();
  const ip = req.ip ?? 'desconocida';
  const previos = (golpes.get(ip) ?? []).filter((t) => ahora - t < VENTANA_MS);
  previos.push(ahora);
  golpes.set(ip, previos);

  if (previos.length > MAX_POR_VENTANA) {
    res.setHeader('retry-after', Math.ceil(VENTANA_MS / 1000));
    return res.status(429).json({ message: 'Demasiadas peticiones, intente en un minuto' });
  }
  next();
});

// La autenticacion la realiza exclusivamente identity-service.
app.post('/auth/login', (req, res) => {
  return res.status(410).json({ message: 'Use el inicio de sesión con correo y contraseña' });
});

// ------------------------------------------------------------------- proxy
/** Reenvia la peticion al microservicio correspondiente. */
function reenviar(base, prefijo = '') {
  return async (req, res) => {
    const destino = base + prefijo + req.url;
    const operationId = req.header('idempotency-key') ?? req.body?.operation_id;
    const cacheKey = operationId ? `${req.method}:${destino}:${operationId}` : null;
    if (cacheKey && respuestasIdempotentes.has(cacheKey)) {
      const previo = respuestasIdempotentes.get(cacheKey);
      res.status(previo.status).set('content-type', previo.contentType).set('x-idempotent-replay', 'true').send(previo.body);
      return;
    }
    const controlador = new AbortController();
    const reloj = setTimeout(() => controlador.abort(), UPSTREAM_TIMEOUT_MS);

    const cabeceras = {
      'x-correlation-id': req.correlationId,
      ...(operationId ? { 'idempotency-key': operationId, 'x-operation-id': operationId } : {}),
      ...(req.header('authorization') ? { authorization: req.header('authorization') } : {}),
      ...(req.header('x-gateway-user-id') ? { 'x-gateway-user-id': req.header('x-gateway-user-id') } : {}),
      ...(req.header('x-gateway-user-roles') ? { 'x-gateway-user-roles': req.header('x-gateway-user-roles') } : {}),
      // order-service orquesta catálogo, inventario y pagos. El Gateway ya
      // conoce las rutas que pasan health; se las entrega para que Pedidos no
      // intente usar localhost dentro de un contenedor Railway.
      ...(prefijo === '/api/v1/orders' ? {
        'x-catalog-service-url': CATALOG_URL,
        'x-inventory-service-url': INVENTORY_URL,
        'x-payment-service-url': PAYMENT_URL,
        'x-producer-service-url': PRODUCER_URL,
      } : {}),
    };
    const llevaCuerpo = !['GET', 'HEAD'].includes(req.method);
    if (llevaCuerpo) cabeceras['content-type'] = req.header('content-type') ?? 'application/json';
    // El parser multipart de Multer necesita recibir el boundary completo y
    // la longitud exacta del buffer reenviado. Sin Content-Length, algunos
    // clientes/proxies cierran el formulario antes del delimitador final.
    if (Buffer.isBuffer(req.body)) {
      // Express ya reconstruyó el cuerpo completo; usa la longitud del
      // buffer real para que el parser multipart aguas arriba no espere
      // bytes que ya no forman parte del cuerpo reenviado.
      cabeceras['content-length'] = String(req.body.length);
    }

    try {
      const respuesta = await fetch(destino, {
        method: req.method,
        headers: cabeceras,
        ...(llevaCuerpo && req.body ? { body: Buffer.isBuffer(req.body) ? req.body : JSON.stringify(req.body) } : {}),
        signal: controlador.signal,
      });

      const texto = await respuesta.text();
      res.status(respuesta.status);
      res.setHeader('content-type', respuesta.headers.get('content-type') ?? 'application/json');
      if (cacheKey && respuesta.status >= 200 && respuesta.status < 300) respuestasIdempotentes.set(cacheKey, { status: respuesta.status, contentType: respuesta.headers.get('content-type') ?? 'application/json', body: texto });
      res.send(texto);
    } catch (err) {
      const esTimeout = err.name === 'AbortError';
      res.status(esTimeout ? 504 : 503).json({
        message: esTimeout
          ? 'El microservicio no respondio a tiempo'
          : 'El microservicio no esta disponible',
        detalle: err.message,
        correlation_id: req.correlationId,
      });
    } finally {
      clearTimeout(reloj);
    }
  };
}

// Las rutas /internal/* de Productores NO se exponen: son servicio-a-servicio.
app.use('/api', async (req, res, next) => {
  const path = req.path.replace(/^\/v1(?=\/|$)/, '');
  if (req.method === 'GET' && path === '/system/health') return next();
  if (req.method === 'POST' && ['/identity/auth/login', '/identity/auth/register', '/identity/auth/email/verify', '/identity/auth/password/reset/request', '/identity/auth/password/reset/confirm'].includes(path)) return next();
  if (path.startsWith('/sim/')) return res.status(404).json({ message: 'Simulador deshabilitado' });
  if (path.includes('/internal')) return res.status(404).json({ message: 'Ruta privada' });
  try {
    const check = await fetch(IDENTITY_URL + '/auth/me', { headers: { authorization: req.header('authorization') ?? '' }, signal: AbortSignal.timeout(8000) });
    if (!check.ok) return res.status(check.status === 401 ? 401 : 503).json({ message: check.status === 401 ? 'Inicie sesión nuevamente' : 'No se pudo validar la sesión' });
    const user = await check.json();
    req.headers['x-gateway-user-id'] = user.id;
    req.headers['x-gateway-user-roles'] = Array.isArray(user.roles) ? user.roles.join(',') : '';
    if (user.roles.includes('admin')) return next();
    const producer = user.roles.includes('producer');
    const read = ['GET', 'HEAD'].includes(req.method);
    if (path.startsWith('/system') || path.includes('/verification') || path.includes('/pending/review') ||
      (path.startsWith('/producer') && !producer) ||
      (path.startsWith('/catalog') && !read && (!producer || path.startsWith('/catalog/categories'))) ||
      path.includes('/inventory/receive') || path.endsWith('/consume'))
      return res.status(403).json({ message: 'Tu cuenta no tiene permisos para esta operación' });
    return next();
  } catch { return res.status(503).json({ message: 'El servicio de acceso no está disponible. Intenta nuevamente.' }); }
});
app.use('/api/producer', (req, res, next) => {
  if (req.url.startsWith('/internal')) {
    return res.status(404).json({ message: 'Ruta no disponible a traves del Gateway' });
  }
  next();
});

app.use('/api/producer', reenviar(PRODUCER_URL));
app.use('/api/catalog', reenviar(CATALOG_URL));
app.use('/api/identity', reenviar(IDENTITY_URL));
app.use('/api/inventory', reenviar(INVENTORY_URL));
app.use('/api/orders', reenviar(ORDER_URL, '/api/v1/orders'));
app.use('/api/payments', reenviar(PAYMENT_URL, '/api/v1/payments'));
app.use('/api/v1/producer', reenviar(PRODUCER_URL));
app.use('/api/v1/catalog', reenviar(CATALOG_URL));
app.use('/api/v1/identity', reenviar(IDENTITY_URL));
app.use('/api/v1/inventory', reenviar(INVENTORY_URL));
app.use('/api/v1/orders', reenviar(ORDER_URL, '/api/v1/orders'));
app.use('/api/v1/payments', reenviar(PAYMENT_URL, '/api/v1/payments'));

// ------------------------------------------------------ Inventario (simulado)
let canalRabbit = null;
let conexionRabbit = null;

async function canal() {
  if (canalRabbit) return canalRabbit;
  conexionRabbit = await amqp.connect(RABBIT_URL);
  conexionRabbit.on('close', () => { canalRabbit = null; conexionRabbit = null; });
  conexionRabbit.on('error', () => { canalRabbit = null; });
  canalRabbit = await conexionRabbit.createChannel();
  await canalRabbit.assertExchange(EXCHANGE, 'topic', { durable: true });
  return canalRabbit;
}

async function publicar(eventType, entityId, payload, { eventId, correlationId, entityVersion = 1 } = {}) {
  const ch = await canal();
  const sobre = {
    event_id: eventId ?? randomUUID(),
    event_type: eventType,
    source_service: eventType.startsWith('inventory.') ? 'inventory-service' : 'identity-service',
    entity_id: entityId,
    entity_version: entityVersion,
    schema_version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: correlationId ?? randomUUID(),
    payload,
  };
  ch.publish(EXCHANGE, eventType, Buffer.from(JSON.stringify(sobre)), {
    contentType: 'application/json',
    persistent: true,
    messageId: sobre.event_id,
    type: eventType,
    correlationId: sobre.correlation_id,
  });
  return sobre;
}

/** Simula a inventory-service publicando un cambio de stock. */
app.post('/api/sim/stock-changed', async (req, res) => {
  const { product_id, stock_version, available_kg, physical_kg, event_id } = req.body ?? {};
  if (!esUuid(product_id)) return res.status(422).json({ message: 'product_id debe ser un UUID' });
  if (!Number.isFinite(Number(stock_version))) return res.status(422).json({ message: 'stock_version invalida' });
  if (!Number.isFinite(Number(available_kg))) return res.status(422).json({ message: 'available_kg invalida' });

  try {
    const sobre = await publicar(
      'inventory.stock_changed',
      product_id,
      {
        product_id,
        stock_version: Number(stock_version),
        available_kg: Number(available_kg),
        physical_kg: Number(physical_kg ?? available_kg),
      },
      { eventId: event_id, correlationId: req.correlationId },
    );
    res.status(202).json({ publicado: true, evento: sobre });
  } catch (err) {
    res.status(503).json({ message: 'No se pudo publicar en RabbitMQ', detalle: err.message });
  }
});

/** Simula a identity-service dando de baja una cuenta. */
app.post('/api/sim/user-disabled', async (req, res) => {
  const { user_id } = req.body ?? {};
  if (!esUuid(user_id)) return res.status(422).json({ message: 'user_id debe ser un UUID' });

  try {
    const sobre = await publicar(
      'identity.user_disabled',
      user_id,
      { user_id, occurred_at: new Date().toISOString() },
      { correlationId: req.correlationId },
    );
    res.status(202).json({ publicado: true, evento: sobre });
  } catch (err) {
    res.status(503).json({ message: 'No se pudo publicar en RabbitMQ', detalle: err.message });
  }
});

// --------------------------------------------------------------- diagnostico
app.get(['/api/system/health', '/api/v1/system/health'], async (_req, res) => {
  const [productor, catalogo, identidad, inventario, pedidos, pagos] = await Promise.all([
    salud(`${PRODUCER_URL}/health/ready`),
    salud(`${CATALOG_URL}/health/ready`),
    salud(`${IDENTITY_URL}/health/ready`),
    salud(`${INVENTORY_URL}/health/ready`),
    salud(`${ORDER_URL}/api/v1/health/ready`),
    salud(`${PAYMENT_URL}/api/v1/health/ready`),
  ]);
  res.json({ 'producer-service': productor, 'catalog-service': catalogo, 'identity-service': identidad, 'inventory-service': inventario, 'order-service': pedidos, 'payment-service': pagos });
});

async function salud(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    // El cuerpo trae su propio campo "status" ("ready" / "not_ready"),
    // por eso el codigo HTTP se expone aparte como "http".
    const cuerpo = await r.json().catch(() => ({}));
    return { alcanzable: true, listo: r.ok, http: r.status, checks: {}, ...cuerpo };
  } catch (err) {
    return { alcanzable: false, listo: false, http: 0, checks: {}, detalle: err.message };
  }
}

/** Estado de las colas, leido de la API de administracion de RabbitMQ. */
app.get(['/api/system/queues', '/api/v1/system/queues'], async (_req, res) => {
  const usuario = process.env.RABBITMQ_USER ?? 'farmtotable';
  const clave = process.env.RABBITMQ_PASS ?? 'farmtotable';
  const auth = Buffer.from(`${usuario}:${clave}`).toString('base64');

  try {
    const r = await fetch(`${RABBIT_MGMT}/api/queues/%2F`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return res.status(502).json({ message: `RabbitMQ respondio ${r.status}` });

    const colas = (await r.json()).map((q) => ({
      nombre: q.name,
      listos: q.messages_ready ?? 0,
      sin_confirmar: q.messages_unacknowledged ?? 0,
      consumidores: q.consumers ?? 0,
      dlq: q.name.endsWith('.dead'),
    }));
    res.json({ colas: colas.sort((a, b) => a.nombre.localeCompare(b.nombre)) });
  } catch (err) {
    res.status(503).json({ message: 'RabbitMQ no disponible', detalle: err.message });
  }
});

// -------------------------------------------------------------------- web
app.use(express.static(join(aqui, 'public'), { extensions: ['html'] }));

app.use((req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
    return res.status(404).json({ message: 'Ruta no encontrada' });
  }
  res.sendFile(join(aqui, 'public', 'index.html'));
});

function esUuid(v) {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FarmToTable Gateway en http://localhost:${PORT}`);
  console.log(`  -> producer-service ${PRODUCER_URL}`);
  console.log(`  -> catalog-service  ${CATALOG_URL}`);
  console.log(`  -> order-service    ${ORDER_URL}`);
  console.log(`  -> payment-service  ${PAYMENT_URL}`);
  console.log(`  -> RabbitMQ         ${RABBIT_URL.replace(/:[^:@]+@/, ':****@')}`);
});

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, async () => {
    await canalRabbit?.close().catch(() => {});
    await conexionRabbit?.close().catch(() => {});
    process.exit(0);
  });
}
