/**
 * FarmToTable - API Gateway + interfaz web.
 *
 * API Gateway: punto de entrada publico, rate limiting, timeouts, correlation_id
 * y enrutado hacia los microservicios. Identidad e Inventario son servicios
 * reales; las rutas /api/sim/* se conservan para publicar eventos de demostracion.
 * El navegador solo habla con este gateway, nunca con los puertos internos.
 */
import express from 'express';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import amqp from 'amqplib';
import Redis from 'ioredis';
import { isAnonymousIdentityPost } from './auth-access.mjs';
import { parseTrustProxy, RedisSlidingWindowRateLimiter, SlidingWindowRateLimiter } from './rate-limiter.mjs';

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
const LOGISTICS_URL = (process.env.LOGISTICS_SERVICE_URL ?? 'http://localhost:3007').replace(/\/+$/, '');
const NOTIFICATION_URL = (process.env.NOTIFICATION_SERVICE_URL ?? 'http://localhost:3008').replace(/\/+$/, '');
const ANALYTICS_URL = (process.env.ANALYTICS_SERVICE_URL ?? 'http://localhost:3009').replace(/\/+$/, '');
const RABBIT_URL = process.env.RABBITMQ_URL ?? buildRabbitUrl();
const EXCHANGE = process.env.RABBITMQ_EXCHANGE ?? 'farmtotable.events';
const RABBIT_MGMT = process.env.RABBITMQ_MGMT_URL ?? 'http://localhost:15672';
// Checkout encadena validación de catálogo, reserva, pago y despacho. Diez
// segundos podía cortar una compra correcta en redes frías antes de que el
// servicio de pedidos terminara sus compensaciones acotadas.
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS ?? '30000', 10);
const TRUST_PROXY = parseTrustProxy(process.env.GATEWAY_TRUST_PROXY ?? '0');

function enteroPositivo(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function buildRabbitUrl() {
  const u = process.env.RABBITMQ_USER ?? 'farmtotable';
  const p = process.env.RABBITMQ_PASS ?? 'farmtotable';
  const h = process.env.RABBITMQ_HOST ?? 'localhost';
  return `amqp://${u}:${p}@${h}:5672`;
}

const app = express();
app.disable('x-powered-by');
// Solo confiar cabeceras forwarded cuando se declara explícitamente el proxy
// que las sobrescribe; confiar en cualquier proxy permitiría falsificar la IP.
app.set('trust proxy', TRUST_PROXY);
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

// Readiness del Gateway evalúa este proceso, no encadena las dependencias de
// todos los microservicios. El panel agregado mantiene su propio endpoint.
app.get('/health/ready', (_req, res) => res.status(200).json({ status: 'ready', service: 'gateway' }));

// ------------------------------------------------------------- rate limiting
// Redis comparte el límite entre réplicas; la memoria acotada mantiene servicio
// disponible si Redis tiene una interrupción temporal.
const VENTANA_MS = 60_000;
const MAX_POR_VENTANA = enteroPositivo(process.env.RATE_LIMIT, 300);
const limitadorLocal = new SlidingWindowRateLimiter({ limit: MAX_POR_VENTANA, windowMs: VENTANA_MS });
const redisRateLimit = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
      retryStrategy: (attempt) => Math.min(1_000, 200 * attempt),
    })
  : null;
redisRateLimit?.on('error', () => {});
void redisRateLimit?.connect().catch(() => {});
const limitadorCompartido = redisRateLimit
  ? new RedisSlidingWindowRateLimiter({ redis: redisRateLimit, limit: MAX_POR_VENTANA, windowMs: VENTANA_MS })
  : null;
let rateLimitDegradado = false;

app.use('/api', async (req, res, next) => {
  const ip = req.ip ?? 'desconocida';
  let resultado;
  if (limitadorCompartido) {
    try {
      resultado = await limitadorCompartido.consume(ip);
      if (rateLimitDegradado) console.warn('Rate limit compartido con Redis restablecido');
      rateLimitDegradado = false;
    } catch {
      if (!rateLimitDegradado) console.warn('Redis no disponible para rate limit; usando límite local acotado');
      rateLimitDegradado = true;
      resultado = limitadorLocal.consume(ip);
    }
  } else {
    resultado = limitadorLocal.consume(ip);
  }
  if (!resultado.allowed) {
    res.setHeader('retry-after', resultado.retryAfter);
    return res.status(429).json({ message: 'Demasiadas peticiones, intente en un minuto' });
  }
  next();
});

// La autenticacion la realiza identity-service; el Gateway no emite tokens.
app.post('/auth/login', (req, res) => {
  return res.status(410).json({ message: 'Use el inicio de sesión con correo y contraseña' });
});

// ------------------------------------------------------------------- proxy
/** Reenvia la peticion al microservicio correspondiente. */
function reenviar(base, prefijo = '') {
  return async (req, res) => {
    const destino = base + prefijo + req.url;
    const operationId = req.header('idempotency-key') ?? req.body?.operation_id;
    // La idempotencia pertenece al microservicio y su almacenamiento duradero.
    // No se cachean respuestas aquí: una caché global en memoria puede filtrar
    // datos entre usuarios que coincidan en la clave y crecer sin límite.
    const controlador = new AbortController();
    const reloj = setTimeout(() => controlador.abort(), UPSTREAM_TIMEOUT_MS);

    const cabeceras = {
      'x-correlation-id': req.correlationId,
      ...(operationId ? { 'idempotency-key': operationId, 'x-operation-id': operationId } : {}),
      ...(req.header('authorization') ? { authorization: req.header('authorization') } : {}),
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
  if (isAnonymousIdentityPost(req.method, path)) return next();
  if (path.startsWith('/sim/')) return res.status(404).json({ message: 'Simulador deshabilitado' });
  if (path.includes('/internal')) return res.status(404).json({ message: 'Ruta privada' });
  try {
    const check = await fetch(IDENTITY_URL + '/auth/me', { headers: { authorization: req.header('authorization') ?? '' }, signal: AbortSignal.timeout(8000) });
    if (!check.ok) return res.status(check.status === 401 ? 401 : 503).json({ message: check.status === 401 ? 'Inicie sesión nuevamente' : 'No se pudo validar la sesión' });
    const user = await check.json();
    if (user.roles.includes('admin')) return next();
    const producer = user.roles.includes('producer');
    const read = ['GET', 'HEAD'].includes(req.method);
    if (path.startsWith('/system') || path.includes('/verification') || path.includes('/pending/review') ||
      (path.startsWith('/producer') && !producer) ||
      (path.startsWith('/catalog') && !read && (!producer || path.startsWith('/catalog/categories'))) ||
      path.includes('/inventory/receive') || path.endsWith('/consume') ||
      ((path.startsWith('/routes') || path.startsWith('/deliveries')) && !user.roles.some((role) => ['driver', 'logistics_admin'].includes(role))) ||
      ((path.startsWith('/drivers') || path.startsWith('/vehicles')) && !user.roles.includes('logistics_admin')))
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
app.use('/api/logistics', reenviar(LOGISTICS_URL, '/api/v1/logistics'));
app.use('/api/v1/logistics', reenviar(LOGISTICS_URL, '/api/v1/logistics'));
app.use('/api/notifications', reenviar(NOTIFICATION_URL, '/api/v1/notifications'));
app.use('/api/v1/notifications', reenviar(NOTIFICATION_URL, '/api/v1/notifications'));
app.use('/api/notification-preferences', reenviar(NOTIFICATION_URL, '/api/v1/notification-preferences'));
app.use('/api/v1/notification-preferences', reenviar(NOTIFICATION_URL, '/api/v1/notification-preferences'));
app.use('/api/analytics', reenviar(ANALYTICS_URL, '/api/v1/analytics'));
app.use('/api/v1/analytics', reenviar(ANALYTICS_URL, '/api/v1/analytics'));
app.use('/api/routes', reenviar(LOGISTICS_URL, '/api/v1/routes'));
app.use('/api/v1/routes', reenviar(LOGISTICS_URL, '/api/v1/routes'));
app.use('/api/drivers', reenviar(LOGISTICS_URL, '/api/v1/drivers'));
app.use('/api/v1/drivers', reenviar(LOGISTICS_URL, '/api/v1/drivers'));
app.use('/api/vehicles', reenviar(LOGISTICS_URL, '/api/v1/vehicles'));
app.use('/api/v1/vehicles', reenviar(LOGISTICS_URL, '/api/v1/vehicles'));
app.use('/api/deliveries', reenviar(LOGISTICS_URL, '/api/v1/deliveries'));
app.use('/api/v1/deliveries', reenviar(LOGISTICS_URL, '/api/v1/deliveries'));

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
  const [productor, catalogo, identidad, inventario, pedidos, pagos, logistica, notificaciones, analitica] = await Promise.all([
    salud(`${PRODUCER_URL}/health/ready`),
    salud(`${CATALOG_URL}/health/ready`),
    salud(`${IDENTITY_URL}/health/ready`),
    salud(`${INVENTORY_URL}/health/ready`),
    salud(`${ORDER_URL}/api/v1/health/ready`),
    salud(`${PAYMENT_URL}/api/v1/health/ready`),
    salud(`${LOGISTICS_URL}/api/v1/health/ready`),
    salud(`${NOTIFICATION_URL}/api/v1/health/ready`),
    salud(`${ANALYTICS_URL}/api/v1/health/ready`),
  ]);
  res.json({ 'producer-service': productor, 'catalog-service': catalogo, 'identity-service': identidad, 'inventory-service': inventario, 'order-service': pedidos, 'payment-service': pagos, 'logistics-service': logistica, 'notification-service': notificaciones, 'analytics-service': analitica });
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
  console.log(`  -> logistics-service ${LOGISTICS_URL}`);
  console.log(`  -> notification-service ${NOTIFICATION_URL}`);
  console.log(`  -> analytics-service ${ANALYTICS_URL}`);
  console.log(`  -> RabbitMQ         ${RABBIT_URL.replace(/:[^:@]+@/, ':****@')}`);
});

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, async () => {
    await canalRabbit?.close().catch(() => {});
    await conexionRabbit?.close().catch(() => {});
    redisRateLimit?.disconnect();
    process.exit(0);
  });
}
