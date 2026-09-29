import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { HealthController } from './health.controller';
import { JwtModule } from '@nestjs/jwt';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.guard';
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({ global: true })], controllers: [PaymentsController, HealthController], providers: [PrismaService, PaymentsService, { provide: APP_GUARD, useClass: AuthGuard }] })
export class AppModule {}
