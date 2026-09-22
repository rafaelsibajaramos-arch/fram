import { Module } from '@nestjs/common';
import { FarmsModule } from '../farms/farms.module';
import { ProducersModule } from '../producers/producers.module';
import { InternalController } from './internal.controller';

@Module({
  imports: [ProducersModule, FarmsModule],
  controllers: [InternalController],
})
export class InternalModule {}
