import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from './prisma.service'; import { EventsService } from './events.service';
@Controller('health')
export class HealthController { constructor(private db: PrismaService, private events: EventsService) {} @Get() health() { return { service: 'identity-service', status: 'ok' }; } @Get('ready') async ready() { let postgres = 'up'; try { await this.db.$queryRaw`SELECT 1`; } catch { postgres = 'down'; } const rabbitmq = this.events.isConnected() ? 'up' : 'down'; if (postgres === 'down' || rabbitmq === 'down') throw new ServiceUnavailableException({ status: 'not_ready', checks: { postgres, rabbitmq } }); return { status: 'ready', checks: { postgres, rabbitmq } }; } }
