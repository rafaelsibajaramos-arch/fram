import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    if (req.path === '/health' || req.path === '/health/ready') return true;
    const [scheme, token] = String(req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) throw new UnauthorizedException('Falta el token Bearer');
    try { const key = Buffer.from(process.env.JWT_PUBLIC_KEY ?? '', 'base64').toString('utf8'); const payload = await this.jwt.verifyAsync(token, { publicKey: key, algorithms: ['RS256'], issuer: process.env.JWT_ISSUER ?? 'farmtotable-identity', audience: process.env.JWT_AUDIENCE ?? 'farmtotable-api' }); if (!payload.sub) throw new Error(); req.user = { sub: String(payload.sub), roles: Array.isArray(payload.roles) ? payload.roles.map(String) : [] }; return true; } catch { throw new UnauthorizedException('Token invalido o expirado'); }
  }
}
