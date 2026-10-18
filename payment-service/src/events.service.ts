import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, AmqpConnectionManager, ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';

export interface DomainEvent {
  event_id: string;
  event_type: string;
  source_service: string;
  entity_id: string;
  entity_version: number;
  schema_version: number;
  occurred_at: string;
  correlation_id: string;
  payload: Record<string, unknown>;
}

type EventHandler = (event: DomainEvent) => Promise<void>;

@Injectable()
export class EventsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EventsService.name);
  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;
  private readonly consumers: ChannelWrapper[] = [];
  private readonly subscriptions: Array<{ queue: string; patterns: string[]; handler: EventHandler }> = [];
  private connected = false;
  private readonly url: string;
  private readonly exchange: string;

  constructor(config: ConfigService) {
    this.url = config.get<string>('RABBITMQ_URL') ?? 'amqp://localhost:5672';
    this.exchange = config.get<string>('RABBITMQ_EXCHANGE') ?? 'farmtotable.events';
  }

  onModuleInit(): void {
    this.connection = connect([this.url], { heartbeatIntervalInSeconds: 15 });
    this.connection.on('connect', () => {
      this.connected = true;
      this.logger.log('Conectado a RabbitMQ');
    });
    this.connection.on('disconnect', ({ err }) => {
      this.connected = false;
      this.logger.warn(`RabbitMQ desconectado: ${err?.message ?? ''}`);
    });
    this.channel = this.connection.createChannel({
      setup: (channel: ConfirmChannel) => channel.assertExchange(this.exchange, 'topic', { durable: true }),
    });
    for (const sub of this.subscriptions) this.startConsumer(sub);
  }

  register(queue: string, patterns: string[], handler: EventHandler): void {
    const sub = { queue, patterns, handler };
    this.subscriptions.push(sub);
    if (this.connection) this.startConsumer(sub);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async publish(event: DomainEvent): Promise<void> {
    if (!this.channel || !this.connected) throw new Error('RabbitMQ no está conectado');
    await this.channel.publish(this.exchange, event.event_type, Buffer.from(JSON.stringify(event)), {
      contentType: 'application/json',
      persistent: true,
      messageId: event.event_id,
      correlationId: event.correlation_id,
      type: event.event_type,
    });
  }

  private startConsumer(sub: { queue: string; patterns: string[]; handler: EventHandler }): void {
    const consumer = this.connection!.createChannel({ setup: async (channel: ConfirmChannel) => {
      const deadExchange = `${this.exchange}.dlx`;
      const deadQueue = `${sub.queue}.dead`;
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      await channel.assertExchange(deadExchange, 'topic', { durable: true });
      await channel.assertQueue(deadQueue, { durable: true });
      await channel.bindQueue(deadQueue, deadExchange, sub.queue);
      await channel.assertQueue(sub.queue, { durable: true, deadLetterExchange: deadExchange, deadLetterRoutingKey: sub.queue });
      for (const pattern of sub.patterns) await channel.bindQueue(sub.queue, this.exchange, pattern);
      await channel.prefetch(10);
      await channel.consume(sub.queue, (message) => void this.handleMessage(channel, sub, message));
    } });
    this.consumers.push(consumer);
  }

  private async handleMessage(channel: ConfirmChannel, sub: { queue: string; handler: EventHandler }, message: import('amqplib').ConsumeMessage | null): Promise<void> {
    if (!message) return;
    try {
      const event = JSON.parse(message.content.toString()) as DomainEvent;
      await sub.handler(event);
      channel.ack(message);
    } catch (error) {
      this.logger.error(`Fallo en ${sub.queue}: ${(error as Error).message}`);
      channel.nack(message, false, !message.fields.redelivered);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.connected = false;
    await Promise.allSettled(this.consumers.map((consumer) => consumer.close()));
    await this.channel?.close();
    await this.connection?.close();
  }
}
