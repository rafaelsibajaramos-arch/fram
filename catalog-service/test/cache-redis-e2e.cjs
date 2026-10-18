const assert = require('node:assert/strict');
const { ConfigService } = require('@nestjs/config');
const { CacheKeys, CacheService } = require('../dist/cache/cache.service');

const redisUrl = process.env.REDIS_URL;
const mode = process.argv[2] ?? 'available';

if (!redisUrl) throw new Error('REDIS_URL es requerido para esta prueba');

function createCache() {
  return new CacheService(new ConfigService({ app: { redisUrl, cacheTtlSeconds: 30 } }));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Redis no alcanzó el estado esperado a tiempo');
}

async function testAvailableRedis() {
  const cache = createCache();
  cache.onModuleInit();
  try {
    await waitFor(() => cache.isAvailable());

    const productId = `redis-e2e-${process.pid}-${Date.now()}`;
    const productKey = CacheKeys.product(productId);
    await cache.set(productKey, { name: 'Tomate' });
    assert.equal(await cache.client.ttl(productKey), 30, 'la entrada predeterminada debe expirar en 30 s');
    assert.deepEqual(await cache.get(productKey), { name: 'Tomate' });

    await cache.set(productKey, { name: 'Temporal' }, { ttlSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal(await cache.get(productKey), null, 'Redis debe expirar la entrada al vencer su TTL');

    await cache.set(productKey, { name: 'Obsoleto' });
    await cache.set(CacheKeys.price(productId), { price: 123 });
    await cache.set(CacheKeys.available(), { data: [] });
    await cache.invalidateProduct(productId);
    assert.equal(await cache.get(productKey), null, 'stock/producto debe invalidar la ficha');
    assert.equal(await cache.get(CacheKeys.price(productId)), null, 'stock/producto debe invalidar el precio');
    assert.equal(await cache.get(CacheKeys.available()), null, 'stock/producto debe invalidar el listado disponible');

    console.log('Redis E2E aprobado: TTL de 30 s, expiración real e invalidación de ficha/precio/listado.');
  } finally {
    await cache.onApplicationShutdown();
  }
}

async function testUnavailableRedis() {
  const cache = createCache();
  cache.onModuleInit();
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(cache.isAvailable(), false, 'la caché debe quedar degradada si Redis no responde');
    assert.equal(await cache.get(CacheKeys.available()), null, 'un fallo debe convertirse en cache miss');
    await assert.doesNotReject(cache.set(CacheKeys.available(), { data: [] }));
    await assert.doesNotReject(cache.invalidateProduct('redis-unavailable-e2e'));
    console.log('Redis fallback E2E aprobado: sin conexión, las lecturas obtienen cache miss y las escrituras/invalidation no rompen.');
  } finally {
    await cache.onApplicationShutdown();
  }
}

(mode === 'unavailable' ? testUnavailableRedis() : testAvailableRedis()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
