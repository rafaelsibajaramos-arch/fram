import { Injectable, OnModuleInit } from '@nestjs/common';
import { AnalyticsService } from '../analytics.service';
import { EventEnvelope } from '../event-envelope';
import { RabbitService } from './rabbit.service';

@Injectable()
export class AnalyticsConsumer implements OnModuleInit {
  constructor(private readonly rabbit: RabbitService, private readonly analytics: AnalyticsService) {}
  onModuleInit() { this.rabbit.register((event: EventEnvelope) => this.analytics.consume(event).then(() => undefined)); }
}
