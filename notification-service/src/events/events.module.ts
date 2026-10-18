import { Global, Module } from '@nestjs/common';
import { NotificationsService } from '../notifications.service';
import { PrismaService } from '../prisma.service';
import { NotificationsConsumer } from './notifications.consumer';
import { OutboxWorker } from './outbox.worker';
import { RabbitService } from './rabbit.service';
import { DispatchWorker } from '../dispatch.worker';

@Global()
@Module({ providers: [PrismaService, RabbitService, NotificationsService, NotificationsConsumer, OutboxWorker, DispatchWorker], exports: [PrismaService, RabbitService, NotificationsService] })
export class EventsModule {}
