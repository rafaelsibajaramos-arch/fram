import { Body, Controller, Delete, ForbiddenException, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { CompletePayoutDto, CreatePaymentDto, CreateSimulatedCardDto, TopUpWalletDto } from './payment.dto';
import { PaymentsService } from './payments.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; roles: string[] };
}
@Controller('payments')
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}
  @Get() list(@Query('buyerId') buyerId: string | undefined, @Req() req: AuthenticatedRequest) { return this.service.list(req.user?.roles?.includes('admin') ? buyerId : req.user?.sub); }
  @Get('payouts') async payouts(@Req() req: AuthenticatedRequest) {
    if (req.user?.roles?.includes('admin')) return this.service.listPayouts();
    if (!req.user?.roles?.includes('producer')) throw new ForbiddenException('Solo productores y administradores pueden consultar liquidaciones');
    const base = String(process.env.PRODUCER_SERVICE_URL ?? 'http://producer-service:3001').replace(/\/+$/, '');
    const internalKey = process.env.INTERNAL_API_KEY ?? '';
    if (!base || !internalKey) throw new ServiceUnavailableException('No está configurada la consulta de perfil productor');
    try {
      const response = await fetch(`${base}/internal/users/${encodeURIComponent(req.user.sub)}/producer`, { headers: { 'x-internal-api-key': internalKey }, signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`producer-service respondió ${response.status}`);
      const profile = await response.json() as { producer_id?: string | null };
      return profile.producer_id ? this.service.listPayouts(profile.producer_id) : [];
    } catch {
      throw new ServiceUnavailableException('No se pudo consultar el perfil del productor');
    }
  }
  @Patch('payouts/:id/complete') completePayout(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: CompletePayoutDto, @Req() req: AuthenticatedRequest, @Headers('x-correlation-id') correlationId?: string) {
    if (!req.user?.roles?.includes('admin')) throw new ForbiddenException('Solo un administrador puede registrar transferencias completadas');
    return this.service.completePayout(id, dto.providerReference, correlationId);
  }
  @Get('/wallet/:buyerId') wallet(@Param('buyerId') buyerId: string, @Req() req: AuthenticatedRequest) { if (req.user?.sub !== buyerId && !req.user?.roles?.includes('admin')) throw new ForbiddenException('No autorizado'); return this.service.wallet(buyerId); }
  @Get('/cards/:buyerId') cards(@Param('buyerId') buyerId: string, @Req() req: AuthenticatedRequest) { this.ownOrAdminBuyer(buyerId, req); return this.service.listCards(buyerId); }
  @Post('/cards/:buyerId') createCard(@Param('buyerId') buyerId: string, @Body() dto: CreateSimulatedCardDto, @Req() req: AuthenticatedRequest) { this.ownOrAdminBuyer(buyerId, req); return this.service.createCard(buyerId, dto); }
  @Delete('/cards/:buyerId/:cardId') deleteCard(@Param('buyerId') buyerId: string, @Param('cardId', new ParseUUIDPipe()) cardId: string, @Req() req: AuthenticatedRequest) { this.ownOrAdminBuyer(buyerId, req); return this.service.deleteCard(buyerId, cardId); }
  @Post('/wallet/:buyerId/top-up') topUp(@Param('buyerId') buyerId: string, @Body() dto: TopUpWalletDto, @Req() req: AuthenticatedRequest, @Headers('x-correlation-id') correlationId?: string) { this.ownOrAdminBuyer(buyerId, req); return this.service.topUp(buyerId, dto, req.user.sub, correlationId); }
  @Get('/by-order/:orderId') async getByOrder(@Param('orderId', new ParseUUIDPipe()) orderId: string, @Req() req: AuthenticatedRequest) { const payment = await this.service.getByOrder(orderId); if (payment.buyerId !== req.user?.sub && !req.user?.roles?.includes('admin')) throw new ForbiddenException('No autorizado'); return payment; }
  @Get(':id') async get(@Param('id') id: string, @Req() req: AuthenticatedRequest) { const payment = await this.service.get(id); if (payment.buyerId !== req.user?.sub && !req.user?.roles?.includes('admin')) throw new ForbiddenException('No autorizado'); return payment; }
  @Post() create(@Body() dto: CreatePaymentDto, @Req() req: AuthenticatedRequest, @Headers('x-correlation-id') correlationId?: string) { return this.service.create(dto, req.user?.sub, correlationId); }
  @Post(':id/fulfillment-lock') lockFulfillment(@Param('id', new ParseUUIDPipe()) id: string, @Body('routeId', new ParseUUIDPipe()) routeId: string, @Headers('x-internal-api-key') key?: string) { this.assertInternalKey(key); return this.service.lockForFulfillment(id, routeId); }
  @Post(':id/fulfillment-unlock') unlockFulfillment(@Param('id', new ParseUUIDPipe()) id: string, @Body('routeId', new ParseUUIDPipe()) routeId: string, @Headers('x-internal-api-key') key?: string) { this.assertInternalKey(key); return this.service.unlockForFulfillment(id, routeId); }
  @Patch(':id/authorize') authorize(@Param('id') id: string, @Req() req: AuthenticatedRequest) { return this.ownOrAdmin(id, req, () => this.service.authorize(id)); }
  @Patch(':id/capture') capture(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Headers('x-internal-api-key') key?: string, @Headers('x-correlation-id') correlationId?: string) { this.assertInternalOrAdmin(req, key); return this.service.capture(id, correlationId); }
  @Patch(':id/void') voidAuthorization(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Headers('x-internal-api-key') key?: string, @Headers('x-correlation-id') correlationId?: string) { this.assertInternalOrAdmin(req, key); return this.service.voidAuthorization(id, correlationId); }
  @Patch(':id/fail') fail(@Param('id') id: string, @Body('reason') reason: string | undefined, @Req() req: AuthenticatedRequest, @Headers('x-correlation-id') correlationId?: string) { if (!req.user?.roles?.includes('admin')) throw new ForbiddenException('Solo un administrador puede rechazar pagos'); return this.service.fail(id, reason, correlationId); }
  @Patch(':id/refund') refund(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Headers('x-correlation-id') correlationId?: string) { if (!req.user?.roles?.includes('admin')) throw new ForbiddenException('Solo un administrador puede reembolsar'); return this.service.refund(id, correlationId); }
  private async ownOrAdmin(id: string, req: AuthenticatedRequest, action: () => Promise<unknown>) { const payment = await this.service.get(id); if (payment.buyerId !== req.user?.sub && !req.user?.roles?.includes('admin')) throw new ForbiddenException('No autorizado'); return action(); }
  private ownOrAdminBuyer(buyerId: string, req: AuthenticatedRequest) { if (buyerId !== req.user?.sub && !req.user?.roles?.includes('admin')) throw new ForbiddenException('No autorizado'); }
  private assertInternalKey(supplied?: string) {
    const expected = process.env.INTERNAL_API_KEY ?? '';
    const valid = Boolean(expected && supplied && Buffer.byteLength(expected) === Buffer.byteLength(supplied) && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)));
    if (!valid) throw new ForbiddenException('Operación solo disponible para servicios internos');
  }
  private assertInternalOrAdmin(req: AuthenticatedRequest, supplied?: string) {
    const expected = process.env.INTERNAL_API_KEY ?? '';
    const validKey = Boolean(expected && supplied && Buffer.byteLength(expected) === Buffer.byteLength(supplied) && timingSafeEqual(Buffer.from(expected), Buffer.from(supplied)));
    if (!validKey && !req.user?.roles?.includes('admin')) throw new ForbiddenException('Operación solo disponible para servicios internos');
  }
}
