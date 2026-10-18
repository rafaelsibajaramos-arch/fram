import { Global, Module } from '@nestjs/common';
import { AnalyticsService } from '../analytics.service';
import { PrismaService } from '../prisma.service';
import { AnalyticsConsumer } from './analytics.consumer';
import { OutboxWorker } from './outbox.worker';
import { RabbitService } from './rabbit.service';

@Global()
@Module({ providers: [PrismaService, RabbitService, AnalyticsService, AnalyticsConsumer, OutboxWorker], exports: [PrismaService, RabbitService, AnalyticsService] })
export class EventsModule {}
