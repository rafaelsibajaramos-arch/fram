import { Controller, Get, HttpStatus, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../cache/cache.service';
import { Public } from '../common/auth/public.decorator';
import { AppConfig } from '../common/config/configuration';
import { RabbitService } from '../events/rabbit.service';
import { PrismaService } from '../prisma/prisma.service';

@Public()
@Controller('health')
export class HealthController {
  private readonly cfg: AppConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitService,
    private readonly cache: CacheService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>('app');
  }

  /** Liveness: el proceso esta funcionando. */
  @Get()
  live() {
    return { status: 'ok', service: this.cfg.serviceName, uptime_s: Math.round(process.uptime()) };
  }

  /**
   * Readiness: PostgreSQL y RabbitMQ son esenciales.
   * Redis es solo cache: si esta caido el servicio sigue estando listo.
   */
  @Get('ready')
  async ready() {
    const checks: Record<string, string> = {};

    try {
      await this.prisma.ping();
      checks.postgres = 'up';
    } catch {
      checks.postgres = 'down';
    }

    checks.rabbitmq = this.rabbit.isConnected() ? 'up' : 'down';
    checks.redis = this.cfg.redisUrl ? (this.cache.isAvailable() ? 'up' : 'down (opcional)') : 'desactivado';

    const listo = checks.postgres === 'up' && checks.rabbitmq === 'up';
    if (!listo) {
      throw new ServiceUnavailableException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        status: 'not_ready',
        checks,
      });
    }
    return { status: 'ready', service: this.cfg.serviceName, checks };
  }
}
