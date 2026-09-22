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
}

export default (): { app: AppConfig } => ({
  app: {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '3001', 10),
    serviceName: process.env.SERVICE_NAME ?? 'producer-service',
    rabbitUrl: process.env.RABBITMQ_URL ?? 'amqp://localhost:5672',
    rabbitExchange: process.env.RABBITMQ_EXCHANGE ?? 'farmtotable.events',
    jwtAlg: (process.env.JWT_ALG as 'HS256' | 'RS256') ?? 'HS256',
    jwtSecret: process.env.JWT_SECRET ?? '',
    // Permite pasar la clave con \n escapados dentro de una variable de entorno
    jwtPublicKey: (process.env.JWT_PUBLIC_KEY ?? '').replace(/\n/g, '\n'),
    internalApiKey: process.env.INTERNAL_API_KEY ?? '',
    authDisabled: process.env.AUTH_DISABLED === 'true',
    outboxPollMs: parseInt(process.env.OUTBOX_POLL_MS ?? '3000', 10),
    outboxBatchSize: parseInt(process.env.OUTBOX_BATCH_SIZE ?? '50', 10),
  },
});
