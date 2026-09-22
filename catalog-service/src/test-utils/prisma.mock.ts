/** Mock minimo de PrismaService para pruebas unitarias sin base de datos. */
export function createPrismaMock() {
  const tx: any = {
    product: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), findMany: jest.fn() },
    category: { findUnique: jest.fn(), findFirst: jest.fn() },
    harvestBatch: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    priceHistory: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    stockState: { findUnique: jest.fn(), upsert: jest.fn() },
    producerRef: { findUnique: jest.fn(), upsert: jest.fn() },
    outboxEvent: { create: jest.fn() },
    processedEvent: { findUnique: jest.fn(), create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'locked' }]),
  };

  const prisma: any = {
    product: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    category: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    harvestBatch: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    priceHistory: { create: jest.fn(), update: jest.fn(), findFirst: jest.fn(), findMany: jest.fn() },
    stockState: { findUnique: jest.fn(), upsert: jest.fn() },
    producerRef: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    outboxEvent: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    processedEvent: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg))),
    $queryRaw: jest.fn(),
    $queryRawUnsafe: jest.fn(),
    ping: jest.fn().mockResolvedValue(true),
    tx,
  };

  return prisma;
}

export function createOutboxMock() {
  return { enqueue: jest.fn().mockResolvedValue(undefined) };
}

export function createCacheMock() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    invalidateProduct: jest.fn().mockResolvedValue(undefined),
    ahora: () => Date.now(),
    isAvailable: () => false,
  };
}

export function createConfigMock(over: Record<string, unknown> = {}) {
  return {
    getOrThrow: () => ({
      nodeEnv: 'test',
      serviceName: 'catalog-service',
      lowStockFactor: 1.1,
      highStockFactor: 0.9,
      cacheTtlSeconds: 30,
      producerServiceUrl: 'http://producer-service:3001',
      producerServiceTimeoutMs: 3000,
      internalApiKey: 'test',
      redisUrl: '',
      ...over,
    }),
  } as any;
}

export const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';
