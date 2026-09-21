import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import { InternalAuthGuard } from './common/auth/internal-auth.guard';
import configuration from './common/config/configuration';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { CertificationsModule } from './certifications/certifications.module';
import { EventsModule } from './events/events.module';
import { FarmsModule } from './farms/farms.module';
import { HealthModule } from './health/health.module';
import { InternalModule } from './internal/internal.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProducersModule } from './producers/producers.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
    JwtModule.register({ global: true }),
    PrismaModule,
    EventsModule,
    ProducersModule,
    FarmsModule,
    CertificationsModule,
    InternalModule,
    HealthModule,
  ],
  providers: [
    InternalAuthGuard,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
