import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { HealthController } from './health.controller';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { EventsService } from './events.service';
import { OutboxWorker } from './outbox.worker';
import { FulfillmentConsumer } from './fulfillment.consumer';
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({ global: true })], controllers: [PaymentsController, HealthController], providers: [PrismaService, PaymentsService, EventsService, OutboxWorker, FulfillmentConsumer, { provide: APP_GUARD, useClass: AuthGuard }] })
export class AppModule {}
