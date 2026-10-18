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
  private consumer?: ChannelWrapper;
  private handler?: Handler;
  private connected = false;
  readonly exchange = process.env.RABBITMQ_EXCHANGE ?? 'farmtotable.events';
  isConnected() { return this.connected; }

  onModuleInit() {
    const url = process.env.RABBITMQ_URL;
    if (!url) { this.logger.warn('RABBITMQ_URL no configurada'); return; }
    this.connection = connect([url], { heartbeatIntervalInSeconds: 15 });
    this.connection.on('connect', () => { this.connected = true; this.logger.log('Conectado a RabbitMQ'); });
    this.connection.on('disconnect', ({ err }) => { this.connected = false; this.logger.warn(`RabbitMQ desconectado: ${err?.message ?? ''}`); });
    this.publisher = this.connection.createChannel({ setup: async (channel: ConfirmChannel) => { await channel.assertExchange(this.exchange, 'topic', { durable: true }); } });
    this.consumer = this.connection.createChannel({ setup: async (channel: ConfirmChannel) => {
      const deadExchange = `${this.exchange}.dlx`; const queue = 'farmtotable.analytics'; const deadQueue = `${queue}.dead`;
      await channel.assertExchange(this.exchange, 'topic', { durable: true }); await channel.assertExchange(deadExchange, 'topic', { durable: true });
      await channel.assertQueue(deadQueue, { durable: true }); await channel.bindQueue(deadQueue, deadExchange, queue);
      await channel.assertQueue(queue, { durable: true, deadLetterExchange: deadExchange, deadLetterRoutingKey: queue });
      for (const pattern of ['payment.captured', 'payment.refunded', 'order.confirmed', 'order.fulfillment_closed', 'harvest.registered', 'inventory.waste_recorded', 'inventory.movement_recorded', 'inventory.stock_changed', 'delivery.scheduled', 'delivery.in_transit', 'delivery.completed', 'delivery.partial', 'delivery.failed', 'delivery.cancelled', 'cold_chain.alert', 'rating.created', 'producer.created', 'producer.updated', 'producer.disabled', 'product.updated', 'product.available', 'product.unavailable']) await channel.bindQueue(queue, this.exchange, pattern);
      await channel.prefetch(10);
      await channel.consume(queue, (message) => void this.consume(channel, message));
    } });
  }

  register(handler: Handler) { this.handler = handler; }

  async publish(event: EventEnvelope) {
    if (!this.publisher || !this.connected) throw new Error('RabbitMQ no está disponible');
    await this.publisher.publish(this.exchange, event.event_type, Buffer.from(JSON.stringify(event)), { contentType: 'application/json', persistent: true, messageId: event.event_id, type: event.event_type, correlationId: event.correlation_id });
  }

  private async consume(channel: ConfirmChannel, message: ConsumeMessage | null) {
    if (!message) return;
    let event: EventEnvelope;
    try { event = JSON.parse(message.content.toString()) as EventEnvelope; }
    catch (error) { this.logger.error(`Mensaje inválido: ${(error as Error).message}`); channel.nack(message, false, false); return; }
    try { if (!this.handler) throw new Error('Consumidor todavía no registrado'); await this.handler(event); channel.ack(message); }
    catch (error) {
      this.logger.error(`Evento ${event.event_type} no procesado: ${(error as Error).message}`);
      const status = typeof (error as { getStatus?: unknown })?.getStatus === 'function' ? (error as { getStatus: () => number }).getStatus() : 500;
      const retries = Number(message.properties.headers?.['x-ftt-retry-count'] ?? 0);
      if ((status >= 400 && status < 500) || !Number.isInteger(retries) || retries >= 3) { channel.nack(message, false, false); return; }
      try {
        const attempt = retries + 1; const exchange = `${this.exchange}.retry`; const routing = `farmtotable.analytics.${event.event_type}`;
        const safe = event.event_type.replace(/[^a-zA-Z0-9_.-]/g, '_'); const retryQueue = `farmtotable.analytics.retry.${safe}.${attempt}`;
        await channel.assertExchange(exchange, 'topic', { durable: true });
        await channel.assertQueue(retryQueue, { durable: true, messageTtl: [5000, 30_000, 120_000][attempt - 1], deadLetterExchange: this.exchange, deadLetterRoutingKey: event.event_type });
        await channel.bindQueue(retryQueue, exchange, routing);
        await new Promise<void>((resolve, reject) => channel.publish(exchange, routing, message.content, { contentType: 'application/json', persistent: true, messageId: message.properties.messageId, correlationId: message.properties.correlationId, type: message.properties.type, headers: { ...message.properties.headers, 'x-ftt-retry-count': attempt } }, (err) => err ? reject(err) : resolve()));
        channel.ack(message);
      } catch (retryError) { this.logger.error(`No se pudo programar reintento: ${(retryError as Error).message}`); channel.nack(message, false, true); }
    }
  }

  async onApplicationShutdown() { this.connected = false; await this.consumer?.close(); await this.publisher?.close(); await this.connection?.close(); }
}
