import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreatePaymentDto } from './payment.dto';
import { PaymentsService } from './payments.service';
@Controller('payments')
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}
  @Get() list(@Query('buyerId') buyerId?: string) { return this.service.list(buyerId); }
  @Get(':id') get(@Param('id') id: string) { return this.service.get(id); }
  @Post() create(@Body() dto: CreatePaymentDto) { return this.service.create(dto); }
  @Patch(':id/authorize') authorize(@Param('id') id: string) { return this.service.authorize(id); }
  @Patch(':id/fail') fail(@Param('id') id: string, @Body('reason') reason?: string) { return this.service.fail(id, reason); }
  @Patch(':id/refund') refund(@Param('id') id: string) { return this.service.refund(id); }
}
