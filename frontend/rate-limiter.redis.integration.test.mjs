import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { RedisSlidingWindowRateLimiter } from './rate-limiter.mjs';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL es obligatorio para la prueba de integración');

test('dos réplicas comparten el límite Redis y liberan la ventana al expirar', async () => {
  const redisA = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 2_000 });
  const redisB = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 2_000 });
  redisA.on('error', () => {});
  redisB.on('error', () => {});

  const prefix = `ftt-test:gateway-rate-limit:${randomUUID()}:`;
  const key = `${prefix}${createHash('sha256').update('203.0.113.42').digest('hex')}`;
  const firstReplica = new RedisSlidingWindowRateLimiter({ redis: redisA, limit: 2, windowMs: 120, keyPrefix: prefix });
  const secondReplica = new RedisSlidingWindowRateLimiter({ redis: redisB, limit: 2, windowMs: 120, keyPrefix: prefix });

  try {
    await Promise.all([redisA.connect(), redisB.connect()]);
    assert.deepEqual(await firstReplica.consume('203.0.113.42'), { allowed: true, retryAfter: 0 });
    assert.deepEqual(await secondReplica.consume('203.0.113.42'), { allowed: true, retryAfter: 0 });
    const blocked = await firstReplica.consume('203.0.113.42');
    assert.equal(blocked.allowed, false, 'la segunda instancia ve los aciertos de la primera');
    assert.ok(blocked.retryAfter >= 1);

    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.deepEqual(await secondReplica.consume('203.0.113.42'), { allowed: true, retryAfter: 0 });
  } finally {
    await redisA.del(key).catch(() => {});
    await Promise.all([redisA.quit().catch(() => {}), redisB.quit().catch(() => {})]);
  }
});
