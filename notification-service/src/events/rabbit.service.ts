import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { AmqpConnectionManager, ChannelWrapper, connect } from 'amqp-connection-manager';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { EventEnvelope } from '../event-envelope';

type Handler = (event: EventEnvelope) => Promise<void>;

@Injectable()
export class RabbitService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitService.name);
  private connection?: AmqpConnectionManager;
  private publisher?: ChannelWrapper;
  private readonly consumers: ChannelWrapper[] = [];
  private readonly subscriptions: Array<{ queue: string; patterns: string[]; handler: Handler }> = [];
  private connected = false;
  readonly exchange = process.env.RABBITMQ_EXCHANGE ?? 'farmtotable.events';

  isConnected() { return this.connected; }

  onModuleInit() {
    const url = process.env.RABBITMQ_URL;
    if (!url) { this.logger.warn('RABBITMQ_URL no configurada; se conservan los eventos en outbox'); return; }
    this.connection = connect([url], { heartbeatIntervalInSeconds: 15 });
    this.connection.on('connect', () => { this.connected = true; this.logger.log('Conectado a RabbitMQ'); });
    this.connection.on('disconnect', ({ err }) => { this.connected = false; this.logger.warn(`RabbitMQ desconectado: ${err?.message ?? ''}`); });
    this.publisher = this.connection.createChannel({ setup: async (channel: ConfirmChannel) => { await channel.assertExchange(this.exchange, 'topic', { durable: true }); } });
    for (const subscription of this.subscriptions) this.startConsumer(subscription);
  }

  register(queue: string, patterns: string[], handler: Handler) {
    const subscription = { queue, patterns, handler };
    this.subscriptions.push(subscription);
    if (this.connection) this.startConsumer(subscription);
  }

  async publish(event: EventEnvelope) {
    if (!this.publisher || !this.connected) throw new Error('RabbitMQ no está disponible');
    await this.publisher.publish(this.exchange, event.event_type, Buffer.from(JSON.stringify(event)), {
      contentType: 'application/json', persistent: true, messageId: event.event_id,
      type: event.event_type, correlationId: event.correlation_id,
      headers: { 'x-source-service': event.source_service, 'x-schema-version': event.schema_version },
    });
  }

  private startConsumer(subscription: { queue: string; patterns: string[]; handler: Handler }) {
    const wrapper = this.connection!.createChannel({ setup: async (channel: ConfirmChannel) => {
      const deadExchange = `${this.exchange}.dlx`;
      const deadQueue = `${subscription.queue}.dead`;
      await channel.assertExchange(this.exchange, 'topic', { durable: true });
      await channel.assertExchange(deadExchange, 'topic', { durable: true });
      await channel.assertQueue(deadQueue, { durable: true });
      await channel.bindQueue(deadQueue, deadExchange, subscription.queue);
      await channel.assertQueue(subscription.queue, { durable: true, deadLetterExchange: deadExchange, deadLetterRoutingKey: subscription.queue });
      for (const pattern of subscription.patterns) await channel.bindQueue(subscription.queue, this.exchange, pattern);
      await channel.prefetch(10);
      await channel.consume(subscription.queue, (message) => void this.consume(channel, subscription, message));
    } });
    this.consumers.push(wrapper);
  }

  private async consume(channel: ConfirmChannel, subscription: { queue: string; handler: Handler }, message: ConsumeMessage | null) {
    if (!message) return;
    let event: EventEnvelope;
    try {
      event = JSON.parse(message.content.toString()) as EventEnvelope;
    } catch (error) {
      this.logger.error(`Mensaje inválido en ${subscription.queue}: ${(error as Error).message}`);
      channel.nack(message, false, false);
      return;
    }
    try {
      await subscription.handler(event);
      channel.ack(message);
    } catch (error) {
      this.logger.error(`No se procesó un evento en ${subscription.queue}: ${(error as Error).message}`);
      const status = typeof (error as { getStatus?: unknown })?.getStatus === 'function' ? (error as { getStatus: () => number }).getStatus() : 500;
      const rawRetries = Number(message.properties.headers?.['x-ftt-retry-count'] ?? 0);
      if (status >= 400 && status < 500 || !Number.isInteger(rawRetries) || rawRetries >= 3) {
        channel.nack(message, false, false);
        return;
      }
      try {
        const attempt = rawRetries + 1;
        const retryExchange = `${this.exchange}.retry`;
        const routingKey = `${subscription.queue}.${event.event_type}`;
        const safeType = event.event_type.replace(/[^a-zA-Z0-9_.-]/g, '_');
        const retryQueue = `${subscription.queue}.retry.${safeType}.${attempt}`;
        const delay = [5000, 30_000, 120_000][attempt - 1];
        await channel.assertExchange(retryExchange, 'topic', { durable: true });
        await channel.assertQueue(retryQueue, { durable: true, messageTtl: delay, deadLetterExchange: this.exchange, deadLetterRoutingKey: event.event_type });
        await channel.bindQueue(retryQueue, retryExchange, routingKey);
        await new Promise<void>((resolve, reject) => channel.publish(retryExchange, routingKey, message.content, {
          contentType: message.properties.contentType ?? 'application/json', persistent: true,
          messageId: message.properties.messageId, correlationId: message.properties.correlationId,
          type: message.properties.type, headers: { ...message.properties.headers, 'x-ftt-retry-count': attempt },
        }, (publishError) => publishError ? reject(publishError) : resolve()));
        channel.ack(message);
      } catch (retryError) {
        this.logger.error(`No se pudo programar reintento durable: ${(retryError as Error).message}`);
        channel.nack(message, false, true);
      }
    }
  }

  async onApplicationShutdown() {
    this.connected = false;
    await Promise.allSettled(this.consumers.map((consumer) => consumer.close()));
    await this.publisher?.close();
    await this.connection?.close();
  }
}
