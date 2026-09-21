import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { AppConfig } from '../config/configuration';

export interface AuthUser {
  sub: string;
  roles: string[];
}

/**
 * Este servicio NO emite JWT ni guarda contrasenas: solo verifica el token
 * emitido por el microservicio de Identidad.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private readonly cfg: AppConfig;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
    private readonly reflector: Reflector,
  ) {
    this.cfg = config.getOrThrow<AppConfig>('app');
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();

    if (this.cfg.authDisabled) {
      // Modo desarrollo: permite probar sin Identity levantado.
      req.user = { sub: req.header('x-debug-user-id') ?? '', roles: ['admin'] } as AuthUser;
      return true;
    }

    const header: string = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Falta el token Bearer');
    }

    try {
      const payload = await this.jwt.verifyAsync(token, this.verifyOptions());
      req.user = {
        sub: payload.sub,
        roles: normalizeRoles(payload),
      } as AuthUser;
      return true;
    } catch (err) {
      this.logger.warn(`JWT invalido: ${(err as Error).message}`);
      throw new UnauthorizedException('Token invalido o expirado');
    }
  }

  private verifyOptions() {
    return this.cfg.jwtAlg === 'RS256'
      ? { algorithms: ['RS256' as const], publicKey: this.cfg.jwtPublicKey }
      : { algorithms: ['HS256' as const], secret: this.cfg.jwtSecret };
  }
}

function normalizeRoles(payload: Record<string, any>): string[] {
  const raw = payload.roles ?? payload.role ?? payload['https://farmtotable/roles'] ?? [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)].filter(Boolean);
}
