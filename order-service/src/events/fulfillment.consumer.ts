import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEnvelope } from './event-envelope';
import { RabbitService } from './rabbit.service';
import { OrdersService } from '../orders.service';

@Injectable()
export class FulfillmentConsumer implements OnModuleInit {
  private readonly logger = new Logger(FulfillmentConsumer.name);
  constructor(private readonly rabbit: RabbitService, private readonly orders: OrdersService) {}

  onModuleInit(): void {
    this.rabbit.register('order-service.fulfillment', ['order.fulfillment_closed', 'delivery.in_transit'], (event) => this.handle(event));
  }

  async handle(event: EventEnvelope): Promise<void> {
    if (event.event_type === 'delivery.in_transit') { await this.orders.consumeDeliveryInTransit(event); return; }
    const order = await this.orders.consumeFulfillmentClosed(event);
    this.logger.log({ msg: 'order_fulfillment_closed', order_id: order.id, status: order.status, payment_status: order.paymentStatus, correlation_id: event.correlation_id });
  }
}
