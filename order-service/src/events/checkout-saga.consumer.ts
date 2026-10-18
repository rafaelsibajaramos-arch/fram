import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEnvelope } from './event-envelope';
import { RabbitService } from './rabbit.service';
import { OrdersService } from '../orders.service';

@Injectable()
export class CheckoutSagaConsumer implements OnModuleInit {
  constructor(private readonly rabbit: RabbitService, private readonly orders: OrdersService) {}

  onModuleInit(): void {
    this.rabbit.register('order-service.checkout-saga', [
      'inventory.order_reserved', 'payment.checkout_authorized', 'inventory.checkout_consumed',
      'inventory.order_reservation_failed', 'inventory.checkout_consumption_failed',
      'payment.checkout_authorization_rejected', 'payment.voided',
    ], async (event: EventEnvelope) => { await this.orders.consumeCheckoutSagaEvent(event); });
  }
}
