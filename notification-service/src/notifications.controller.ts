import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Patch, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { SetNotificationPreferenceDto } from './notification.dto';
import { NotificationsService } from './notifications.service';

interface AuthenticatedRequest extends Request {
  user: { sub: string; roles: string[] };
}

@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('notifications/me') listMine(@Req() req: AuthenticatedRequest, @Query('limit') limit?: string) {
    return this.notifications.list(req.user.sub, parseLimit(limit));
  }

  @Get('notifications/user/:id') listUser(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: AuthenticatedRequest, @Query('limit') limit?: string) {
    this.requireOwnerOrAdmin(req, id);
    return this.notifications.list(id, parseLimit(limit));
  }

  @Patch('notifications/:id/read') markRead(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: AuthenticatedRequest) {
    return this.notifications.markRead(id, req.user.sub);
  }

  @Get('notification-preferences') preferences(@Req() req: AuthenticatedRequest, @Query('user_id') userId?: string) {
    const owner = userId ?? req.user.sub;
    this.requireOwnerOrAdmin(req, owner);
    return this.notifications.preferences(owner);
  }

  @Put('notification-preferences') setPreference(@Body() dto: SetNotificationPreferenceDto, @Req() req: AuthenticatedRequest) {
    return this.notifications.setPreference(req.user.sub, dto);
  }

  private requireOwnerOrAdmin(req: AuthenticatedRequest, userId: string) {
    if (req.user.sub !== userId && !req.user.roles?.includes('admin')) throw new ForbiddenException('Solo puedes consultar tus notificaciones');
  }
}

function parseLimit(value?: string) {
  const parsed = Number(value ?? 50);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 50;
}
