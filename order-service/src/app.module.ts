import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { HealthController } from './health.controller';

@Module({ imports: [ConfigModule.forRoot({ isGlobal: true })], controllers: [OrdersController, HealthController], providers: [PrismaService, OrdersService] })
export class AppModule {}
