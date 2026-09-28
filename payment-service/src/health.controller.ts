import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service';
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Get() live() { return { status: 'ok', service: 'payment-service', uptime_s: Math.round(process.uptime()) }; }
  @Get('ready') async ready() { try { await this.prisma.$queryRaw`SELECT 1`; return { status: 'ready', service: 'payment-service', checks: { postgres: 'up' } }; } catch { throw new ServiceUnavailableException({ status: 'not_ready', checks: { postgres: 'down' } }); } }
}
