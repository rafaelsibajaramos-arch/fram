import { Body, Controller, ForbiddenException, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { Request } from 'express';
import { CreatePaymentDto } from './payment.dto';
import { PaymentsService } from './payments.service';
import { wompiConfig } from './wompi';

interface AuthenticatedRequest extends Request {
  user: { sub: string; roles: string[] };
}
@Controller('payments')
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}
  @Get('wompi/config') config() { wompiConfig(); return { provider: 'wompi', environment: 'sandbox', configured: true }; }
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
  @Get('/by-order/:orderId') async getByOrder(@Param('orderId', new ParseUUIDPipe()) orderId: string, @Req() req: AuthenticatedRequest) { const payment = await this.service.getByOrder(orderId); if (payment.buyerId !== req.user?.sub && !req.user?.roles?.includes('admin')) throw new ForbiddenException('No autorizado'); return payment; }
  @Get('wompi/checkout/:orderId') checkout(@Param('orderId', new ParseUUIDPipe()) id: string, @Req() req: AuthenticatedRequest) { return this.service.checkoutSession(id, req.user.sub); }
  @Post('wompi/events') event(@Body() body: unknown) { return this.service.wompiEvent(body); }
  @Get(':id') async get(@Param('id') id: string, @Req() req: AuthenticatedRequest) { const payment = await this.service.get(id); if (payment.buyerId !== req.user?.sub && !req.user?.roles?.includes('admin')) throw new ForbiddenException('No autorizado'); return payment; }
  @Post() create(@Body() dto: CreatePaymentDto, @Req() req: AuthenticatedRequest, @Headers('x-correlation-id') correlationId?: string) { this.assertInternalKey(req.headers['x-internal-api-key'] as string); return this.service.create(dto, undefined, correlationId); }
  @Post(':id/fulfillment-lock') lockFulfillment(@Param('id', new ParseUUIDPipe()) id: string, @Body('routeId', new ParseUUIDPipe()) routeId: string, @Headers('x-internal-api-key') key?: string) { this.assertInternalKey(key); return this.service.lockForFulfillment(id, routeId); }
  @Post(':id/fulfillment-unlock') unlockFulfillment(@Param('id', new ParseUUIDPipe()) id: string, @Body('routeId', new ParseUUIDPipe()) routeId: string, @Headers('x-internal-api-key') key?: string) { this.assertInternalKey(key); return this.service.unlockForFulfillment(id, routeId); }
  @Patch(':id/void') voidAuthorization(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Headers('x-internal-api-key') key?: string, @Headers('x-correlation-id') correlationId?: string) { this.assertInternalOrAdmin(req, key); return this.service.voidAuthorization(id, correlationId); }
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
