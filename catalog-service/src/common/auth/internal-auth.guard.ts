import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import { AppConfig } from '../config/configuration';

/**
 * Autenticacion servicio-a-servicio para /internal/*.
 * Estas rutas no son publicas y no deben exponerse desde Internet.
 */
@Injectable()
export class InternalAuthGuard implements CanActivate {
  private readonly cfg: AppConfig;

  constructor(config: ConfigService) {
    this.cfg = config.getOrThrow<AppConfig>('app');
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (this.cfg.authDisabled) return true;

    const provided = ctx.switchToHttp().getRequest().header('x-internal-api-key') ?? '';
    const expected = this.cfg.internalApiKey;
    if (!expected || !safeEquals(provided, expected)) {
      throw new UnauthorizedException('Clave de servicio invalida');
    }
    return true;
  }
}

function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
