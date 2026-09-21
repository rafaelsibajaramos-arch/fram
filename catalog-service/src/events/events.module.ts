import { Global, Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { OutboxWorker } from './outbox.worker';
import { RabbitService } from './rabbit.service';

@Global()
@Module({
  providers: [RabbitService, OutboxService, OutboxWorker],
  exports: [RabbitService, OutboxService, OutboxWorker],
})
export class EventsModule {}
