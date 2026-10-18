import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { EventsService } from './events.service';
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly events: EventsService) {}
  @Get() live() { return { status: 'ok', service: 'payment-service', uptime_s: Math.round(process.uptime()) }; }
  @Get('ready') async ready() {
    let postgres = 'up';
    try { await this.prisma.$queryRaw`SELECT 1`; } catch { postgres = 'down'; }
    const rabbitmq = this.events.isConnected() ? 'up' : 'down';
    if (postgres === 'down' || rabbitmq === 'down') throw new ServiceUnavailableException({ status: 'not_ready', checks: { postgres, rabbitmq } });
    return { status: 'ready', service: 'payment-service', checks: { postgres, rabbitmq } };
  }
}
