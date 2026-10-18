import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DomainEvent, EventsService } from './events.service';
import { PaymentsService } from './payments.service';

@Injectable()
export class FulfillmentConsumer implements OnModuleInit {
  private readonly logger = new Logger(FulfillmentConsumer.name);

  constructor(private readonly events: EventsService, private readonly payments: PaymentsService) {}

  onModuleInit(): void {
    this.events.register('payment-service.fulfillment', ['order.confirmed', 'order.fulfillment_closed'], (event) => this.handle(event));
    this.events.register('payment-service.checkout', ['inventory.order_reserved', 'order.cancelled'], async (event) => {
      if (event.event_type === 'inventory.order_reserved') await this.payments.authorizeCheckoutFromInventory(event);
      else await this.payments.compensateCheckoutCancellation(event);
    });
  }

  async handle(event: DomainEvent): Promise<void> {
    if (event.event_type === 'order.confirmed') {
      if (event.source_service !== 'order-service') throw new Error('order.confirmed debe provenir de order-service');
      await this.payments.registerOrderConfirmed(event);
      this.logger.log({ msg: 'payment_charge_details_registered', order_id: String(event.payload.orderId ?? event.entity_id), correlation_id: event.correlation_id });
      return;
    }
    if (event.source_service !== 'logistics-service') throw new Error(`Cierre de entrega no confiable: ${event.source_service}`);
    const payment = await this.payments.settleFulfillment(event);
    this.logger.log({ msg: 'payment_settled_from_fulfillment', order_id: payment.orderId, payment_id: payment.id, status: payment.status, captured_amount: payment.capturedAmount.toString(), correlation_id: event.correlation_id });
  }
}
