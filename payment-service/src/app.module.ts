import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { HealthController } from './health.controller';
@Module({ imports: [ConfigModule.forRoot({ isGlobal: true })], controllers: [PaymentsController, HealthController], providers: [PrismaService, PaymentsService] })
export class AppModule {}
