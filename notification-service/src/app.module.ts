import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthGuard } from './auth.guard';
import { EventsModule } from './events/events.module';
import { HealthController } from './health.controller';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), JwtModule.register({ global: true }), EventsModule],
  controllers: [NotificationsController, HealthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
