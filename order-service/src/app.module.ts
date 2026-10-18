import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { HealthController } from './health.controller';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
import { EventsModule } from './events/events.module';
import { OutboxWorker } from './events/outbox.worker';
import { FulfillmentConsumer } from './events/fulfillment.consumer';
import { CheckoutSagaConsumer } from './events/checkout-saga.consumer';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({ global: true }), EventsModule], controllers: [OrdersController, HealthController], providers: [PrismaService, OrdersService, OutboxWorker, FulfillmentConsumer, CheckoutSagaConsumer, { provide: APP_GUARD, useClass: AuthGuard }] })
export class AppModule {}
