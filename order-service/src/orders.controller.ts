import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { CreateOrderDto, UpsertCartDto } from './orders.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}
  @Get('/health') health() { return { status: 'ok', service: 'order-service' }; }
  @Get('/cart/:buyerId') cart(@Param('buyerId') buyerId: string, @Req() req: any) { this.assertBuyer(req, buyerId); return this.service.getCart(buyerId); }
  @Put('/cart/:buyerId') cartUpsert(@Param('buyerId') buyerId: string, @Body() dto: UpsertCartDto, @Req() req: any) { this.assertBuyer(req, buyerId); return this.service.upsertCart(buyerId, dto); }
  @Delete('/cart/:buyerId') cartClear(@Param('buyerId') buyerId: string, @Req() req: any) { this.assertBuyer(req, buyerId); return this.service.clearCart(buyerId); }
  @Get() list(@Query('buyerId') buyerId: string | undefined, @Req() req: any) { const target = req.user.roles?.includes('admin') ? buyerId : req.user.sub; return this.service.list(target); }
  @Get(':id') async get(@Param('id') id: string, @Req() req: any) { const order = await this.service.get(id); this.assertBuyer(req, order.buyerId); return order; }
  @Post() create(@Body() dto: CreateOrderDto, @Req() req: any) { return this.service.checkout(dto, req.user.sub, req.bearer, req.headers['x-gateway-user-id'], req.headers['x-gateway-user-roles']); }
  @Post('checkout') checkout(@Body() dto: CreateOrderDto, @Req() req: any) { return this.service.checkout(dto, req.user.sub, req.bearer, req.headers['x-gateway-user-id'], req.headers['x-gateway-user-roles']); }
  @Patch(':id/status') status(@Param('id') id: string, @Body('status') status: OrderStatus, @Req() req: any) { if (!req.user.roles?.includes('admin')) throw new ForbiddenException('Solo un administrador puede cambiar el estado'); return this.service.updateStatus(id, status); }
  private assertBuyer(req: any, buyerId: string) { if (req.user?.sub !== buyerId && !req.user?.roles?.includes('admin')) throw new ForbiddenException('No autorizado'); }
}
