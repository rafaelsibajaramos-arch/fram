import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { timingSafeEqual } from 'node:crypto';
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    if (req.path.endsWith('/health') || req.path.endsWith('/health/ready')) return true;
    if (/^\/api\/v1\/payments\/[0-9a-f-]+\/fulfillment-(?:un)?lock$/i.test(req.path) && validInternalKey(req.headers['x-internal-api-key'])) {
      req.user = { sub: '00000000-0000-4000-8000-000000000000', roles: [], service: true };
      return true;
    }
    const [scheme, token] = String(req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedException('Falta el token Bearer');
    try { const key = decodePublicKey(process.env.JWT_PUBLIC_KEY ?? ''); const payload = await this.jwt.verifyAsync(token, { publicKey: key, algorithms: ['RS256'], issuer: process.env.JWT_ISSUER ?? 'farmtotable-identity', audience: process.env.JWT_AUDIENCE ?? 'farmtotable-api' }); if (!payload.sub) throw new Error(); req.user = { sub: String(payload.sub), roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [] }; return true; } catch { throw new UnauthorizedException('Token invalido o expirado'); }
  }
}

function validInternalKey(supplied: unknown) {
  const expected = process.env.INTERNAL_API_KEY ?? '';
  const candidate = String(supplied ?? '');
  return Boolean(expected && candidate && Buffer.byteLength(expected) === Buffer.byteLength(candidate) && timingSafeEqual(Buffer.from(expected), Buffer.from(candidate)));
}

function decodePublicKey(value: string): string {
  const normalized = String(value ?? '').replace(/\\n/g, '\n').trim();
  if (normalized.includes('BEGIN ')) return normalized;
  return Buffer.from(normalized, 'base64').toString('utf8').replace(/\\n/g, '\n').trim();
}
