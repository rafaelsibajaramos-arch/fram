import { Controller, Get, Headers, NotFoundException, Param, ParseUUIDPipe, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { PrismaService } from './prisma.service';

@Controller('internal/users')
export class InternalController {
  constructor(private readonly db: PrismaService) {}

  /** Contact snapshot for trusted private services; never proxied through the public Gateway. */
  @Get(':id/contact') async contact(@Param('id', new ParseUUIDPipe()) id: string, @Headers('x-internal-api-key') supplied?: string) {
    this.requireInternalKey(supplied);
    const user = await this.db.user.findUnique({ where: { id }, select: { id: true, email: true, fullName: true, status: true } });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return { id: user.id, email: user.email, full_name: user.fullName, status: user.status };
  }

  private requireInternalKey(supplied?: string) {
    const expected = process.env.INTERNAL_API_KEY ?? '';
    const provided = Buffer.from(String(supplied ?? ''));
    const configured = Buffer.from(expected);
    if (!expected || provided.length !== configured.length || !timingSafeEqual(provided, configured)) throw new UnauthorizedException('Clave de servicio inválida');
  }
}
