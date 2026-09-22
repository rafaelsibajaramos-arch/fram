import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AppCacheModule } from './cache/cache.module';
import { CategoriesModule } from './categories/categories.module';
import { JwtAuthGuard } from './common/auth/jwt-auth.guard';
import configuration from './common/config/configuration';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ConsumersModule } from './consumers/consumers.module';
import { EventsModule } from './events/events.module';
import { HarvestBatchesModule } from './harvest-batches/harvest-batches.module';
import { HealthModule } from './health/health.module';
import { PricesModule } from './prices/prices.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProducerClientModule } from './producer-client/producer-client.module';
import { ProductsModule } from './products/products.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration], cache: true }),
    JwtModule.register({ global: true }),
    PrismaModule,
    AppCacheModule,
    EventsModule,
    ProducerClientModule,
    CategoriesModule,
    PricesModule,
    ProductsModule,
    HarvestBatchesModule,
    ConsumersModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
