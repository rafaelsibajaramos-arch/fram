import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { HarvestBatchesController } from './harvest-batches.controller';
import { HarvestBatchesService } from './harvest-batches.service';

@Module({
  imports: [ProductsModule],
  controllers: [HarvestBatchesController],
  providers: [HarvestBatchesService],
  exports: [HarvestBatchesService],
})
export class HarvestBatchesModule {}
