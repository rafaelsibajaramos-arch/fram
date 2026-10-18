import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RabbitService } from './events/rabbit.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: PrismaService, private readonly rabbit: RabbitService) {}
  @Get() live() { return { service: 'analytics-service', status: 'ok', uptime_s: Math.round(process.uptime()) }; }
  @Get('ready') async ready() {
    let postgres = 'up';
    try { await this.db.$queryRaw`SELECT 1`; } catch { postgres = 'down'; }
    const rabbitmq = this.rabbit.isConnected() ? 'up' : 'down';
    if (postgres === 'down' || rabbitmq === 'down') throw new ServiceUnavailableException({ status: 'not_ready', checks: { postgres, rabbitmq } });
    return { status: 'ready', service: 'analytics-service', checks: { postgres, rabbitmq } };
  }
}
