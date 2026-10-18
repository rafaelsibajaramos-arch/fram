import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from '../events/outbox.service';
import { RabbitService } from '../events/rabbit.service';

type MockDelegate = Record<string, jest.Mock>;
export type PrismaMock = Omit<PrismaService, 'producer' | 'farm' | 'certification' | 'outboxEvent' | 'processedEvent' | '$transaction' | '$queryRaw' | '$queryRawUnsafe' | 'ping'> & {
  producer: MockDelegate;
  farm: MockDelegate;
  certification: MockDelegate;
  outboxEvent: MockDelegate;
  processedEvent: MockDelegate;
  $transaction: jest.Mock;
  $queryRaw: jest.Mock;
  $queryRawUnsafe: jest.Mock;
  ping: jest.Mock;
  tx: {
    producer: MockDelegate;
    farm: MockDelegate;
    certification: MockDelegate;
    outboxEvent: MockDelegate;
    processedEvent: MockDelegate;
  };
};

/** Mock mínimo de PrismaService para pruebas unitarias sin base de datos. */
export function createPrismaMock() {
  const tx = {
    producer: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    farm: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    certification: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    outboxEvent: { create: jest.fn() },
    processedEvent: { findUnique: jest.fn(), create: jest.fn() },
  };

  const prisma: PrismaMock = {
    producer: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
    farm: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    certification: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    outboxEvent: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    processedEvent: { findUnique: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(async (arg: unknown) => {
      if (typeof arg === 'function') return arg(tx);
      return Promise.all(arg as readonly Promise<unknown>[]);
    }),
    $queryRaw: jest.fn(),
    $queryRawUnsafe: jest.fn(),
    ping: jest.fn().mockResolvedValue(true),
    tx,
  } as unknown as PrismaMock;

  return prisma;
}

/** Adapta el doble explícito al contrato nominal del servicio inyectado. */
export function asPrismaService(mock: PrismaMock): PrismaService {
  return mock as unknown as PrismaService;
}

export function asRabbitService(mock: Pick<RabbitService, 'register' | 'isConnected'>): RabbitService {
  return mock as unknown as RabbitService;
}

export type OutboxMock = Omit<OutboxService, 'enqueue'> & { enqueue: jest.Mock };

export function asOutboxService(mock: OutboxMock): OutboxService {
  return mock as unknown as OutboxService;
}

export function createOutboxMock(): OutboxMock {
  return { enqueue: jest.fn().mockResolvedValue(undefined) } as unknown as OutboxMock;
}

export const CORRELATION_ID = '11111111-1111-4111-8111-111111111111';

export const ADMIN_USER = { sub: '22222222-2222-4222-8222-222222222222', roles: ['admin'] };

export function producerUser(userId: string) {
  return { sub: userId, roles: ['producer'] };
}
