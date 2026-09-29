import { Body, Controller, ForbiddenException, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { CreatePaymentDto, TopUpWalletDto } from './payment.dto';
import { PaymentsService } from './payments.service';
@Controller('payments')
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}
  @Get() list(@Query('buyerId') buyerId?: string) { return this.service.list(buyerId); }
  @Get('/wallet/:buyerId') wallet(@Param('buyerId') buyerId: string, @Req() req: any) { if (req.user?.sub !== buyerId && !req.user?.roles?.includes('admin')) throw new ForbiddenException('No autorizado'); return this.service.wallet(buyerId); }
  @Post('/wallet/:buyerId/top-up') topUp(@Param('buyerId') buyerId: string, @Body() dto: TopUpWalletDto, @Req() req: any) { if (!req.user?.roles?.includes('admin')) throw new ForbiddenException('Solo un administrador puede recargar'); return this.service.topUp(buyerId, dto, req.user.sub); }
  @Get(':id') get(@Param('id') id: string) { return this.service.get(id); }
  @Post() create(@Body() dto: CreatePaymentDto, @Req() req: any) { return this.service.create(dto, req.user?.sub); }
  @Patch(':id/authorize') authorize(@Param('id') id: string) { return this.service.authorize(id); }
  @Patch(':id/fail') fail(@Param('id') id: string, @Body('reason') reason?: string) { return this.service.fail(id, reason); }
  @Patch(':id/refund') refund(@Param('id') id: string) { return this.service.refund(id); }
}
