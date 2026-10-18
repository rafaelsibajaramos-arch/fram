import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrustProxy, RedisSlidingWindowRateLimiter, SlidingWindowRateLimiter } from './rate-limiter.mjs';

test('ventana deslizante libera peticiones al vencer y da retry-after real', () => {
  let now = 1_000;
  const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 10_000, now: () => now });

  assert.deepEqual(limiter.consume('ip-a'), { allowed: true, retryAfter: 0 });
  now += 1_000;
  assert.deepEqual(limiter.consume('ip-a'), { allowed: true, retryAfter: 0 });
  assert.deepEqual(limiter.consume('ip-a'), { allowed: false, retryAfter: 9 });

  now = 11_001;
  assert.deepEqual(limiter.consume('ip-a'), { allowed: true, retryAfter: 0 });
});

test('peticiones bloqueadas no aumentan memoria y los clientes quedan acotados', () => {
  let now = 0;
  const limiter = new SlidingWindowRateLimiter({
    limit: 2,
    windowMs: 1_000,
    maxClients: 1,
    sweepEvery: 100,
    now: () => now,
  });

  assert.equal(limiter.consume('ip-a').allowed, true);
  assert.equal(limiter.consume('ip-a').allowed, true);
  for (let i = 0; i < 10_000; i += 1) limiter.consume('ip-a');
  assert.equal(limiter.trackedClients, 1);
  assert.equal(limiter.trackedRequests, 2, 'los intentos rechazados no se almacenan');
  assert.equal(limiter.consume('ip-b').allowed, false, 'rechaza nuevas claves mientras todas están activas');

  now = 1_001;
  assert.equal(limiter.consume('ip-b').allowed, true, 'limpia las IP vencidas y admite una nueva');
  assert.equal(limiter.trackedClients, 1);
});

test('trust proxy es explícito y no acepta confiar en cualquier origen', () => {
  assert.equal(parseTrustProxy('0'), false);
  assert.equal(parseTrustProxy('1'), 1);
  assert.deepEqual(parseTrustProxy('loopback, 10.0.0.0/8'), ['loopback', '10.0.0.0/8']);
  assert.throws(() => parseTrustProxy('true'), /no acepta true/);
});

test('Redis usa una clave opaca por IP y devuelve el retry-after compartido', async () => {
  const calls = [];
  const redis = { eval: async (...args) => { calls.push(args); return [0, 7]; } };
  const limiter = new RedisSlidingWindowRateLimiter({ redis, limit: 3, windowMs: 60_000 });

  assert.deepEqual(await limiter.consume('203.0.113.15'), { allowed: false, retryAfter: 7 });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /ZREMRANGEBYSCORE.*ZADD/s, 'pasa el script Lua atómico como primer argumento');
  assert.equal(calls[0][1], 1);
  assert.match(calls[0][2], /^farmtotable:gateway:rate-limit:[a-f0-9]{64}$/);
  assert.equal(calls[0][2].includes('203.0.113.15'), false, 'no almacena la IP en claro en Redis');
  assert.equal(calls[0][3], '60000');
  assert.equal(calls[0][4], '3');
  assert.match(calls[0][5], /^[0-9a-f-]{36}$/);
});

test('Redis limiter propaga fallas para activar el respaldo local del Gateway', async () => {
  const limiter = new RedisSlidingWindowRateLimiter({
    redis: { eval: async () => { throw new Error('redis desconectado'); } },
    limit: 1,
    windowMs: 1000,
  });
  await assert.rejects(limiter.consume('ip-a'), /redis desconectado/);
});
