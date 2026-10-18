import { Injectable, OnModuleInit } from '@nestjs/common';
import { EventEnvelope } from '../event-envelope';
import { NotificationsService } from '../notifications.service';
import { RabbitService } from './rabbit.service';

const QUEUE = 'farmtotable.notifications';
const PATTERNS = [
  'delivery.in_transit', 'delivery.arrived',
  'order.confirmed', 'order.cancelled',
  'delivery.scheduled', 'delivery.completed', 'delivery.partial', 'delivery.failed', 'delivery.cancelled',
  'payment.authorized', 'payment.captured', 'payment.completed', 'payment.failed', 'payment.refunded', 'payout.scheduled', 'payout.completed',
  'cold_chain.alert', 'stock.low', 'product.available', 'product.unavailable', 'identity.user_created',
  'identity.user_disabled', 'identity.roles_changed', 'rating.created',
];

@Injectable()
export class NotificationsConsumer implements OnModuleInit {
  constructor(private readonly rabbit: RabbitService, private readonly notifications: NotificationsService) {}
  onModuleInit() { this.rabbit.register(QUEUE, PATTERNS, async (event: EventEnvelope) => { await this.notifications.consume(event); }); }
}
