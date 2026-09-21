import { HttpModule } from '@nestjs/axios';
import { Global, Module } from '@nestjs/common';
import { ProducerClientService } from './producer-client.service';

@Global()
@Module({
  imports: [HttpModule.register({ timeout: 5000, maxRedirects: 0 })],
  providers: [ProducerClientService],
  exports: [ProducerClientService],
})
export class ProducerClientModule {}
