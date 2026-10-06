import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { CreateOrderDto, UpsertCartDto } from './orders.dto';
import { CheckoutUpstreams, OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}
  @Get('/health') health() { return { status: 'ok', service: 'order-service' }; }
  @Get('/cart/:buyerId') cart(@Param('buyerId') buyerId: string, @Req() req: any) { this.assertBuyer(req, buyerId); return this.service.getCart(buyerId); }
  @Put('/cart/:buyerId') cartUpsert(@Param('buyerId') buyerId: string, @Body() dto: UpsertCartDto, @Req() req: any) { this.assertBuyer(req, buyerId); return this.service.upsertCart(buyerId, dto); }
  @Delete('/cart/:buyerId') cartClear(@Param('buyerId') buyerId: string, @Req() req: any) { this.assertBuyer(req, buyerId); return this.service.clearCart(buyerId); }
  @Get() list(@Query('buyerId') buyerId: string | undefined, @Req() req: any) { if (req.user.roles?.includes('admin')) return this.service.list(buyerId); if (req.user.roles?.includes('producer')) return this.service.listForProducer(req.user.sub, req.bearer, req.headers['x-gateway-user-id'], req.headers['x-gateway-user-roles'], this.upstreams(req)); return this.service.list(req.user.sub); }
  @Get(':id') async get(@Param('id') id: string, @Req() req: any) { if (req.user.roles?.includes('admin')) return this.service.get(id); if (req.user.roles?.includes('producer')) return this.service.getForProducer(id, req.user.sub, req.bearer, req.headers['x-gateway-user-id'], req.headers['x-gateway-user-roles'], this.upstreams(req)); const order = await this.service.get(id); this.assertBuyer(req, order.buyerId); return order; }
  @Post() create(@Body() dto: CreateOrderDto, @Req() req: any) { return this.service.checkout(dto, req.user.sub, req.bearer, req.headers['x-gateway-user-id'], req.headers['x-gateway-user-roles'], this.upstreams(req)); }
  @Post('checkout') checkout(@Body() dto: CreateOrderDto, @Req() req: any) { return this.service.checkout(dto, req.user.sub, req.bearer, req.headers['x-gateway-user-id'], req.headers['x-gateway-user-roles'], this.upstreams(req)); }
  @Patch(':id/status') status(@Param('id') id: string, @Body('status') status: OrderStatus, @Req() req: any) { if (!req.user.roles?.includes('admin')) throw new ForbiddenException('Solo un administrador puede cambiar el estado'); return this.service.updateStatus(id, status); }
  private assertBuyer(req: any, buyerId: string) { if (req.user?.sub !== buyerId && !req.user?.roles?.includes('admin')) throw new ForbiddenException('No autorizado'); }
  private upstreams(req: any): CheckoutUpstreams {
    const header = (name: string) => Array.isArray(req.headers[name]) ? req.headers[name][0] : req.headers[name];
    return { catalog: header('x-catalog-service-url'), inventory: header('x-inventory-service-url'), payment: header('x-payment-service-url'), producer: header('x-producer-service-url') };
  }
}
