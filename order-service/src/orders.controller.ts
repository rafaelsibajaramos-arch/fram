import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { CreateOrderDto, CreateOrderRatingDto, UpsertCartDto } from './orders.dto';
import { CheckoutUpstreams, OrdersService } from './orders.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; roles?: string[] };
  bearer: string;
}

@Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}
  @Get('/health') health() { return { status: 'ok', service: 'order-service' }; }
  @Get('/cart/:buyerId') cart(@Param('buyerId') buyerId: string, @Req() req: AuthenticatedRequest) { this.assertBuyer(req, buyerId); return this.service.getCart(buyerId); }
  @Put('/cart/:buyerId') cartUpsert(@Param('buyerId') buyerId: string, @Body() dto: UpsertCartDto, @Req() req: AuthenticatedRequest) { this.assertBuyer(req, buyerId); return this.service.upsertCart(buyerId, dto); }
  @Delete('/cart/:buyerId') cartClear(@Param('buyerId') buyerId: string, @Req() req: AuthenticatedRequest) { this.assertBuyer(req, buyerId); return this.service.clearCart(buyerId); }
  @Get() list(@Query('buyerId') buyerId: string | undefined, @Req() req: AuthenticatedRequest) { if (req.user.roles?.includes('admin')) return this.service.list(buyerId); if (req.user.roles?.includes('producer')) return this.service.listForProducer(req.user.sub, req.bearer, this.gatewayUserId(req), this.gatewayRoles(req), this.upstreams(req)); return this.service.list(req.user.sub); }
  @Get(':id') async get(@Param('id') id: string, @Req() req: AuthenticatedRequest) { if (req.user.roles?.includes('admin')) return this.service.get(id); if (req.user.roles?.includes('producer')) return this.service.getForProducer(id, req.user.sub, req.bearer, this.gatewayUserId(req), this.gatewayRoles(req), this.upstreams(req)); const order = await this.service.get(id); this.assertBuyer(req, order.buyerId); return order; }
  @Post(':id/rating') rate(@Param('id') id: string, @Body() dto: CreateOrderRatingDto, @Req() req: AuthenticatedRequest) { return this.service.rate(id, req.user.sub, dto, this.correlationId(req)); }
  @Get(':id/rating') rating(@Param('id') id: string, @Req() req: AuthenticatedRequest) { return this.service.getRating(id, req.user.sub); }
  @Post() create(@Body() dto: CreateOrderDto, @Req() req: AuthenticatedRequest) { return this.service.startCheckoutSaga(dto, req.user.sub, req.bearer, this.gatewayUserId(req), this.gatewayRoles(req), this.upstreams(req), this.correlationId(req)); }
  @Post('checkout') checkout(@Body() dto: CreateOrderDto, @Req() req: AuthenticatedRequest) { return this.service.startCheckoutSaga(dto, req.user.sub, req.bearer, this.gatewayUserId(req), this.gatewayRoles(req), this.upstreams(req), this.correlationId(req)); }
  @Post('checkout/async') checkoutAsync(@Body() dto: CreateOrderDto, @Req() req: AuthenticatedRequest) { return this.service.startCheckoutSaga(dto, req.user.sub, req.bearer, this.gatewayUserId(req), this.gatewayRoles(req), this.upstreams(req), this.correlationId(req)); }
  @Patch(':id/status') status(@Param('id') id: string, @Body('status') status: OrderStatus, @Req() req: AuthenticatedRequest) { if (!req.user.roles?.includes('admin')) throw new ForbiddenException('Solo un administrador puede cambiar el estado'); return this.service.updateStatus(id, status); }
  private assertBuyer(req: AuthenticatedRequest, buyerId: string) { if (req.user?.sub !== buyerId && !req.user?.roles?.includes('admin')) throw new ForbiddenException('No autorizado'); }
  private gatewayUserId(req: AuthenticatedRequest): string | undefined { const value = req.headers['x-gateway-user-id']; return Array.isArray(value) ? value[0] : value; }
  private gatewayRoles(req: AuthenticatedRequest): string | undefined { const value = req.headers['x-gateway-user-roles']; return Array.isArray(value) ? value[0] : value; }
  private correlationId(req: AuthenticatedRequest): string { const value = req.headers['x-correlation-id']; return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : randomUUID(); }
  private upstreams(req: AuthenticatedRequest): CheckoutUpstreams {
    const header = (name: string) => { const value = req.headers[name]; return Array.isArray(value) ? value[0] : value; };
    return { catalog: header('x-catalog-service-url'), inventory: header('x-inventory-service-url'), payment: header('x-payment-service-url'), producer: header('x-producer-service-url') };
  }
}
