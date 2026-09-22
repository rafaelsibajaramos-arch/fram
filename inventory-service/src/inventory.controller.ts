import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { InventoryService } from './inventory.service'; import { ReceiveDto, ReserveDto, WasteDto } from './dto'; import { AuthUser } from './auth';
type RequestWithUser = { user: AuthUser; correlationId?: string };
@Controller('inventory')
export class InventoryController {
  constructor(private s: InventoryService) {}
  @Post('receive') receive(@Body() d: ReceiveDto, @Req() req: RequestWithUser) { return this.s.receive(d, req.correlationId); }
  @Get('products/:productId') byProduct(@Param('productId', new ParseUUIDPipe()) id: string) { return this.s.byProduct(id); }
  @Post('reservations') reserve(@Body() d: ReserveDto, @Req() req: RequestWithUser) { return this.s.reserve(d, req.user.sub, req.correlationId); }
  @Post('reservations/:id/release') release(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: RequestWithUser) { return this.s.release(id, req.user.sub, req.correlationId); }
  @Post('reservations/:id/consume') consume(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: RequestWithUser) { return this.s.consume(id, req.user.sub, req.correlationId); }
  @Post('waste') waste(@Body() d: WasteDto, @Req() req: RequestWithUser) { if (!req.user.roles.includes('admin')) throw new ForbiddenException('Solo un administrador puede reconocer una merma'); return this.s.waste(d, req.correlationId); }
}
