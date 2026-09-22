import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { PricesModule } from '../prices/prices.module';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [CategoriesModule, PricesModule],
  controllers: [ProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
