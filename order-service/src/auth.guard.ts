import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    if (req.path.endsWith('/health') || req.path.endsWith('/health/ready') || req.path.endsWith('/orders/health')) return true;
    // El gateway ya comprobó el Bearer contra Identity y solo se expone
    // públicamente el gateway; conserva esa identidad entre servicios.
    if (req.headers['x-gateway-user-id']) { req.user = { sub: String(req.headers['x-gateway-user-id']), roles: String(req.headers['x-gateway-user-roles'] ?? '').split(',').filter(Boolean) }; req.bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''); return true; }
    const [scheme, token] = String(req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedException('Falta el token Bearer');
    try {
      const publicKey = decodePublicKey(process.env.JWT_PUBLIC_KEY ?? '');
      const payload = await this.jwt.verifyAsync(token, { publicKey, algorithms: ['RS256'], issuer: process.env.JWT_ISSUER ?? 'farmtotable-identity', audience: process.env.JWT_AUDIENCE ?? 'farmtotable-api' });
      if (!payload.sub || !Array.isArray(payload.roles)) throw new Error('claims incompletos');
      req.user = { sub: String(payload.sub), roles: payload.roles.map(String) };
      req.bearer = token;
      return true;
    } catch { throw new UnauthorizedException('Token invalido o expirado'); }
  }
}

function decodePublicKey(value: string): string {
  const normalized = String(value ?? '').replace(/\\n/g, '\n').trim();
  if (normalized.includes('BEGIN ')) return normalized;
  return Buffer.from(normalized, 'base64').toString('utf8').replace(/\\n/g, '\n').trim();
}
