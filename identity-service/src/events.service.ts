import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, AmqpConnectionManager, ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';

export interface DomainEvent { event_id: string; event_type: string; source_service: string; entity_id: string; entity_version: number; schema_version: number; occurred_at: string; correlation_id: string; payload: Record<string, unknown>; }

@Injectable()
export class EventsService implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(EventsService.name); private connection?: AmqpConnectionManager; private channel?: ChannelWrapper; private connected = false;
  readonly exchange: string; private readonly url: string;
  constructor(config: ConfigService) { this.exchange = config.get<string>('RABBITMQ_EXCHANGE') ?? 'farmtotable.events'; this.url = config.get<string>('RABBITMQ_URL') ?? 'amqp://localhost:5672'; }
  onModuleInit(): void { this.connection = connect([this.url], { heartbeatIntervalInSeconds: 15 }); this.connection.on('connect', () => { this.connected = true; this.log.log('Conectado a RabbitMQ'); }); this.connection.on('disconnect', ({ err }) => { this.connected = false; this.log.warn(`RabbitMQ desconectado: ${err?.message ?? ''}`); }); this.channel = this.connection.createChannel({ setup: (channel: ConfirmChannel) => channel.assertExchange(this.exchange, 'topic', { durable: true }) }); }
  isConnected(): boolean { return this.connected; }
  async publish(event: DomainEvent): Promise<void> { if (!this.channel) throw new Error('RabbitMQ no inicializado'); await this.channel.publish(this.exchange, event.event_type, Buffer.from(JSON.stringify(event)), { contentType: 'application/json', persistent: true, messageId: event.event_id, correlationId: event.correlation_id, type: event.event_type }); }
  async onApplicationShutdown(): Promise<void> { await this.channel?.close(); await this.connection?.close(); }
}
