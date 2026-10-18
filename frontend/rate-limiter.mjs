import { createHash, randomUUID } from 'node:crypto';

/** Ventana deslizante local, acotada por IP y por cantidad de clientes. */
export class SlidingWindowRateLimiter {
  constructor({ limit, windowMs, maxClients = 10_000, sweepEvery = 256, now = Date.now }) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit debe ser entero positivo');
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new TypeError('windowMs debe ser entero positivo');
    if (!Number.isSafeInteger(maxClients) || maxClients < 1) throw new TypeError('maxClients debe ser entero positivo');
    if (!Number.isSafeInteger(sweepEvery) || sweepEvery < 1) throw new TypeError('sweepEvery debe ser entero positivo');
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxClients = maxClients;
    this.sweepEvery = sweepEvery;
    this.now = now;
    this.entries = new Map();
    this.calls = 0;
  }

  consume(key) {
    const now = this.now();
    const tracked = this.entries.has(key);
    if (!tracked && this.entries.size >= this.maxClients) this.sweep(now);
    if (!tracked && this.entries.size >= this.maxClients) {
      return { allowed: false, retryAfter: Math.ceil(this.windowMs / 1000) };
    }

    const previous = this.entries.get(key) ?? [];
    const active = previous.filter((timestamp) => now - timestamp < this.windowMs);
    const allowed = active.length < this.limit;
    if (allowed) active.push(now);

    if (active.length) this.entries.set(key, active);
    else this.entries.delete(key);

    this.calls += 1;
    if (this.calls % this.sweepEvery === 0) this.sweep(now);

    return {
      allowed,
      retryAfter: allowed
        ? 0
        : Math.max(1, Math.ceil((active[0] + this.windowMs - now) / 1000)),
    };
  }

  sweep(now = this.now()) {
    for (const [key, timestamps] of this.entries) {
      const active = timestamps.filter((timestamp) => now - timestamp < this.windowMs);
      if (active.length) this.entries.set(key, active);
      else this.entries.delete(key);
    }
  }

  get trackedClients() {
    return this.entries.size;
  }

  get trackedRequests() {
    let total = 0;
    for (const timestamps of this.entries.values()) total += timestamps.length;
    return total;
  }
}

const REDIS_SLIDING_WINDOW_SCRIPT = `
local nowParts = redis.call('TIME')
local now = (tonumber(nowParts[1]) * 1000) + math.floor(tonumber(nowParts[2]) / 1000)
local windowMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - windowMs)
local count = redis.call('ZCARD', KEYS[1])
if count >= limit then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  local retryAfter = math.max(1, math.ceil((tonumber(oldest[2]) + windowMs - now) / 1000))
  return {0, retryAfter}
end
redis.call('ZADD', KEYS[1], now, ARGV[3])
redis.call('PEXPIRE', KEYS[1], windowMs)
return {1, 0}
`;

/** Ventana atómica y compartida por réplicas, con IP hasheada en la clave. */
export class RedisSlidingWindowRateLimiter {
  constructor({ redis, limit, windowMs, keyPrefix = 'farmtotable:gateway:rate-limit:' }) {
    if (!redis || typeof redis.eval !== 'function') throw new TypeError('redis debe exponer eval');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit debe ser entero positivo');
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) throw new TypeError('windowMs debe ser entero positivo');
    this.redis = redis;
    this.limit = limit;
    this.windowMs = windowMs;
    this.keyPrefix = keyPrefix;
  }

  async consume(clientKey) {
    const digest = createHash('sha256').update(String(clientKey)).digest('hex');
    const [allowed, retryAfter] = await this.redis.eval(
      REDIS_SLIDING_WINDOW_SCRIPT,
      1,
      `${this.keyPrefix}${digest}`,
      String(this.windowMs),
      String(this.limit),
      randomUUID(),
    );
    return { allowed: Number(allowed) === 1, retryAfter: Number(retryAfter) || 0 };
  }
}

export function parseTrustProxy(value = '0') {
  const raw = String(value).trim();
  if (!raw || raw === 'false' || raw === '0') return false;
  if (raw === 'true') throw new TypeError('GATEWAY_TRUST_PROXY no acepta true; declara saltos o subredes confiables');
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw.split(',').map((part) => part.trim()).filter(Boolean);
}
