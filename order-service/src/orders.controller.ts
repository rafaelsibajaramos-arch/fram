import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { CreateOrderDto, UpsertCartDto } from './orders.dto';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly service: OrdersService) {}
  @Get('/health') health() { return { status: 'ok', service: 'order-service' }; }
  @Get('/cart/:buyerId') cart(@Param('buyerId') buyerId: string) { return this.service.getCart(buyerId); }
  @Put('/cart/:buyerId') cartUpsert(@Param('buyerId') buyerId: string, @Body() dto: UpsertCartDto) { return this.service.upsertCart(buyerId, dto); }
  @Delete('/cart/:buyerId') cartClear(@Param('buyerId') buyerId: string) { return this.service.clearCart(buyerId); }
  @Get() list(@Query('buyerId') buyerId?: string) { return this.service.list(buyerId); }
  @Get(':id') get(@Param('id') id: string) { return this.service.get(id); }
  @Post() create(@Body() dto: CreateOrderDto) { return this.service.create(dto); }
  @Patch(':id/status') status(@Param('id') id: string, @Body('status') status: OrderStatus) { return this.service.updateStatus(id, status); }
}
