import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { AmqpConnectionManager, ChannelWrapper, connect } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import { EventEnvelope } from './event-envelope';

@Injectable()
export class RabbitService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitService.name);
  private connection?: AmqpConnectionManager;
  private channel?: ChannelWrapper;
  private readonly consumers: ChannelWrapper[] = [];
  private readonly subscriptions: Array<{ queue: string; patterns: string[]; handler: (event: EventEnvelope) => Promise<void> }> = [];
  private connected = false;
  readonly exchange = process.env.RABBITMQ_EXCHANGE ?? 'farmtotable.events';

  isConnected(): boolean { return this.connected; }

  onModuleInit(): void {
    const url = process.env.RABBITMQ_URL;
    if (!url) {
      this.logger.warn('RABBITMQ_URL no está configurada; los eventos permanecerán en el outbox');
      return;
    }
    this.connection = connect([url], { heartbeatIntervalInSeconds: 15 });
    this.connection.on('connect', () => { this.connected = true; this.logger.log('Conectado a RabbitMQ'); });
    this.connection.on('disconnect', ({ err }) => { this.connected = false; this.logger.warn(`RabbitMQ desconectado: ${err?.message ?? 'sin detalle'}`); });
    this.channel = this.connection.createChannel({ setup: async (channel: ConfirmChannel) => {
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
    } });
    for (const sub of this.subscriptions) this.startConsumer(sub);
  }

  register(queue: string, patterns: string[], handler: (event: EventEnvelope) => Promise<void>): void {
    const sub = { queue, patterns, handler };
    this.subscriptions.push(sub);
    if (this.connection) this.startConsumer(sub);
  }

  async publish(routingKey: string, envelope: EventEnvelope): Promise<void> {
    if (!this.channel) throw new Error('Canal de publicación RabbitMQ no inicializado');
    await this.channel.publish(this.exchange, routingKey, Buffer.from(JSON.stringify(envelope)), {
      contentType: 'application/json', persistent: true, messageId: envelope.event_id,
      type: envelope.event_type, correlationId: envelope.correlation_id,
      timestamp: Date.parse(envelope.occurred_at),
      headers: { 'x-source-service': envelope.source_service, 'x-schema-version': envelope.schema_version },
    });
  }

  private startConsumer(sub: { queue: string; patterns: string[]; handler: (event: EventEnvelope) => Promise<void> }): void {
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

  private async handleMessage(channel: ConfirmChannel, sub: { queue: string; handler: (event: EventEnvelope) => Promise<void> }, message: import('amqplib').ConsumeMessage | null): Promise<void> {
    if (!message) return;
    try {
      await sub.handler(JSON.parse(message.content.toString()) as EventEnvelope);
      channel.ack(message);
    } catch (error) {
      this.logger.error(`Fallo en ${sub.queue}: ${(error as Error).message}`);
      channel.nack(message, false, !message.fields.redelivered);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled(this.consumers.map((consumer) => consumer.close()));
    await this.channel?.close();
    await this.connection?.close();
  }
}
