import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AmqpConnectionManager, ChannelWrapper, connect } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { AppConfig } from '../common/config/configuration';
import { EventEnvelope } from './event-envelope';

export type EventHandler = (envelope: EventEnvelope) => Promise<void>;

interface Subscription {
  queue: string;
  patterns: string[];
  handler: EventHandler;
}

/**
 * Capa unica de RabbitMQ: exchange topic durable + colas durables con DLQ.
 * No se asume orden global de entrega; cada consumidor controla duplicados.
 */
@Injectable()
export class RabbitService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitService.name);
  private readonly cfg: AppConfig;
  private connection?: AmqpConnectionManager;
  private publishChannel?: ChannelWrapper;
  private readonly subscriptions: Subscription[] = [];
  private readonly consumerChannels: ChannelWrapper[] = [];
  private connected = false;

  constructor(config: ConfigService) {
    this.cfg = config.getOrThrow<AppConfig>('app');
  }

  get exchange(): string {
    return this.cfg.rabbitExchange;
  }

  get dlx(): string {
    return `${this.cfg.rabbitExchange}.dlx`;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onModuleInit(): void {
    this.connection = connect([this.cfg.rabbitUrl], { heartbeatIntervalInSeconds: 15 });
    this.connection.on('connect', () => {
      this.connected = true;
      this.logger.log('Conectado a RabbitMQ');
    });
    this.connection.on('disconnect', ({ err }) => {
      this.connected = false;
      this.logger.warn(`RabbitMQ desconectado: ${err?.message ?? 'sin detalle'}`);
    });

    this.publishChannel = this.connection.createChannel({
      json: false,
      setup: async (channel: ConfirmChannel) => {
        await channel.assertExchange(this.exchange, 'topic', { durable: true });
        await channel.assertExchange(this.dlx, 'topic', { durable: true });
      },
    });

    for (const sub of this.subscriptions) {
      this.startConsumer(sub);
    }
  }

  /** Registrar antes de onModuleInit (desde el constructor de un consumidor). */
  register(queue: string, patterns: string[], handler: EventHandler): void {
    const sub = { queue, patterns, handler };
    this.subscriptions.push(sub);
    if (this.connection) this.startConsumer(sub);
  }

  async publish(routingKey: string, envelope: EventEnvelope): Promise<void> {
    if (!this.publishChannel) throw new Error('Canal de publicacion no inicializado');
    await this.publishChannel.publish(this.exchange, routingKey, Buffer.from(JSON.stringify(envelope)), {
      contentType: 'application/json',
      persistent: true,
      messageId: envelope.event_id,
      type: envelope.event_type,
      correlationId: envelope.correlation_id,
      timestamp: Date.parse(envelope.occurred_at),
      headers: { 'x-source-service': envelope.source_service, 'x-schema-version': envelope.schema_version },
    });
  }

  private startConsumer(sub: Subscription): void {
    const deadQueue = `${sub.queue}.dead`;

    const channel = this.connection!.createChannel({
      setup: async (ch: ConfirmChannel) => {
        await ch.assertExchange(this.exchange, 'topic', { durable: true });
        await ch.assertExchange(this.dlx, 'topic', { durable: true });
        await ch.assertQueue(deadQueue, { durable: true });
        await ch.bindQueue(deadQueue, this.dlx, sub.queue);
        await ch.assertQueue(sub.queue, {
          durable: true,
          deadLetterExchange: this.dlx,
          deadLetterRoutingKey: sub.queue,
        });
        for (const pattern of sub.patterns) {
          await ch.bindQueue(sub.queue, this.exchange, pattern);
        }
        await ch.prefetch(10);
        await ch.consume(sub.queue, (msg) => this.handleMessage(ch, sub, msg));
      },
    });

    this.consumerChannels.push(channel);
    this.logger.log(`Consumidor listo: ${sub.queue} <- [${sub.patterns.join(', ')}]`);
  }

  private async handleMessage(ch: ConfirmChannel, sub: Subscription, msg: ConsumeMessage | null): Promise<void> {
    if (!msg) return;
    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(msg.content.toString()) as EventEnvelope;
    } catch {
      this.logger.error(`Mensaje ilegible en ${sub.queue}, va a DLQ`);
      ch.nack(msg, false, false);
      return;
    }

    try {
      await sub.handler(envelope);
      ch.ack(msg);
    } catch (err) {
      const redelivered = msg.fields.redelivered;
      this.logger.error(
        `Fallo procesando ${envelope.event_type} (${envelope.event_id}) en ${sub.queue}: ${(err as Error).message}`,
      );
      // Un reintento; si vuelve a fallar se envia a la DLQ para inspeccion manual.
      ch.nack(msg, false, !redelivered);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.consumerChannels.map((c) => c.close()));
    await this.publishChannel?.close();
    await this.connection?.close();
  }
}
