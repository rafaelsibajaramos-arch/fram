import { Module } from '@nestjs/common';
import { ProducersModule } from '../producers/producers.module';
import { FarmsController, ProducerFarmsController } from './farms.controller';
import { FarmsService } from './farms.service';

@Module({
  imports: [ProducersModule],
  controllers: [ProducerFarmsController, FarmsController],
  providers: [FarmsService],
  exports: [FarmsService],
})
export class FarmsModule {}
