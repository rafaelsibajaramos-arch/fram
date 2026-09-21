export interface AppConfig {
  nodeEnv: string;
  port: number;
  serviceName: string;
  rabbitUrl: string;
  rabbitExchange: string;
  jwtAlg: 'HS256' | 'RS256';
  jwtSecret: string;
  jwtPublicKey: string;
  internalApiKey: string;
  authDisabled: boolean;
  outboxPollMs: number;
  outboxBatchSize: number;
  /** URL REST de producer-service para validar producer_id y farm_id */
  producerServiceUrl: string;
  producerServiceTimeoutMs: number;
  redisUrl: string;
  /** TTL de la cache del catalogo (seccion 42) */
  cacheTtlSeconds: number;
  /** Factores de precio dinamico: decision de diseno configurable (seccion 55) */
  lowStockFactor: number;
  highStockFactor: number;
}

export default (): { app: AppConfig } => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '3002', 10),
    serviceName: process.env.SERVICE_NAME ?? 'catalog-service',
    rabbitUrl: process.env.RABBITMQ_URL ?? 'amqp://localhost:5672',
    rabbitExchange: process.env.RABBITMQ_EXCHANGE ?? 'farmtotable.events',
    jwtAlg: (process.env.JWT_ALG as 'HS256' | 'RS256') ?? 'HS256',
    jwtSecret: process.env.JWT_SECRET ?? '',
    jwtPublicKey: (process.env.JWT_PUBLIC_KEY ?? '').replace(/\\n/g, '\n'),
    internalApiKey: process.env.INTERNAL_API_KEY ?? '',
    authDisabled: process.env.AUTH_DISABLED === 'true',
    outboxPollMs: parseInt(process.env.OUTBOX_POLL_MS ?? '3000', 10),
    outboxBatchSize: parseInt(process.env.OUTBOX_BATCH_SIZE ?? '50', 10),
    producerServiceUrl: (process.env.PRODUCER_SERVICE_URL ?? 'http://localhost:3001').replace(/\/+$/, ''),
    producerServiceTimeoutMs: parseInt(process.env.PRODUCER_SERVICE_TIMEOUT_MS ?? '3000', 10),
    redisUrl: process.env.REDIS_URL ?? '',
    cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS ?? '30', 10),
    lowStockFactor: parseFloat(process.env.LOW_STOCK_FACTOR ?? '1.10'),
    highStockFactor: parseFloat(process.env.HIGH_STOCK_FACTOR ?? '0.90'),
  },
});
