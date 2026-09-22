import { Module } from '@nestjs/common';
import { PricesModule } from '../prices/prices.module';
import { ProductsModule } from '../products/products.module';
import { InventoryConsumer } from './inventory.consumer';
import { ProducerConsumer } from './producer.consumer';

/** InventoryConsumerModule de la especificacion, mas el consumidor de producer.*. */
@Module({
  imports: [ProductsModule, PricesModule],
  providers: [InventoryConsumer, ProducerConsumer],
})
export class ConsumersModule {}
