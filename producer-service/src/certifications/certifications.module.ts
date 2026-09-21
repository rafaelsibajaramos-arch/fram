import { Module } from '@nestjs/common';
import { ProducersModule } from '../producers/producers.module';
import { CertificationsController, ProducerCertificationsController } from './certifications.controller';
import { CertificationsService } from './certifications.service';

@Module({
  imports: [ProducersModule],
  controllers: [ProducerCertificationsController, CertificationsController],
  providers: [CertificationsService],
  exports: [CertificationsService],
})
export class CertificationsModule {}
