/** Mock minimo de PrismaService para pruebas unitarias sin base de datos. */
export function createPrismaMock() {
  const tx = {
    producer: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    farm: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    certification: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    outboxEvent: { create: jest.fn() },
    processedEvent: { findUnique: jest.fn(), create: jest.fn() },
  };

  const prisma: any = {
    producer: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    farm: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    certification: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
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

export const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';

export const ADMIN_USER = { sub: '22222222-2222-4222-8222-222222222222', roles: ['admin'] };

export function producerUser(userId: string) {
  return { sub: userId, roles: ['producer'] };
}
