import { Module } from '@nestjs/common'; import { ConfigModule } from '@nestjs/config'; import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller'; import { AuthService } from './auth.service'; import { PrismaService } from './prisma.service'; import { HealthController } from './health.controller'; import { EventsService } from './events.service'; import { OutboxWorker } from './outbox.worker'; import { InternalController } from './internal.controller';
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({ global: true })], controllers: [AuthController, HealthController, InternalController], providers: [AuthService, PrismaService, EventsService, OutboxWorker] })
export class AppModule {}
