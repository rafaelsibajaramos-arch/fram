import { CanActivate, ExecutionContext, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt'; import { Reflector } from '@nestjs/core';
export const PUBLIC = 'inventory-public'; export const Public = () => SetMetadata(PUBLIC, true);
export interface AuthUser { sub: string; sid: string; roles: string[]; rolesVersion: number; }
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private reflector: Reflector) {}
  async canActivate(ctx: ExecutionContext) {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    if (req.header('x-gateway-user-id')) { req.user = { sub: req.header('x-gateway-user-id'), sid: 'gateway', roles: String(req.header('x-gateway-user-roles') ?? '').split(',').filter(Boolean), rolesVersion: 0 } as AuthUser; return true; }
    const [scheme, token] = String(req.header('authorization') ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedException('Falta el token Bearer');
    try {
      const publicKey = decodePublicKey(process.env.JWT_PUBLIC_KEY ?? '');
      const payload = await this.jwt.verifyAsync(token, { publicKey, algorithms: ['RS256'], issuer: process.env.JWT_ISSUER ?? 'farmtotable-identity', audience: process.env.JWT_AUDIENCE ?? 'farmtotable-api' });
      if (!payload.sub || !payload.sid || !Number.isInteger(payload.roles_version)) throw new Error('claims incompletos');
      req.user = { sub: String(payload.sub), sid: String(payload.sid), roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [], rolesVersion: Number(payload.roles_version) } as AuthUser;
      return true;
    }
    catch { throw new UnauthorizedException('Token invalido o expirado'); }
  }
}

function decodePublicKey(value: string): string {
  const normalized = String(value ?? '').replace(/\\n/g, '\n').trim();
  if (normalized.includes('BEGIN ')) return normalized;
  return Buffer.from(normalized, 'base64').toString('utf8').replace(/\\n/g, '\n').trim();
}
