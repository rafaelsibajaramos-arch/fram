import { Body, Controller, ForbiddenException, Get, Headers, Ip, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { CreateProducerApplicationDto, InvitationAcceptDto, InviteDto, LoginDto, PasswordResetConfirmDto, PasswordResetRequestDto, RefreshDto, RegisterDto, RevokeSessionDto, ReviewProducerApplicationDto, UpdateRolesDto, VerifyEmailDto } from './dto';

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}
  @Post('register') register(@Body() d: RegisterDto) { return this.auth.register(d); }
  @Post('login') login(@Body() d: LoginDto, @Req() req: Request, @Ip() ip: string) { return this.auth.login(d, { userAgent: req.header('user-agent'), ipAddress: ip }); }
  @Post('refresh') refresh(@Body() d: RefreshDto, @Req() req: Request, @Ip() ip: string) { return this.auth.refresh(d, { userAgent: req.header('user-agent'), ipAddress: ip }); }
  @Post('logout') logout(@Body() d: RefreshDto) { return this.auth.logout(d.refresh_token); }
  @Post('logout-all') async logoutAll(@Headers('authorization') header: string) { const user = await this.auth.authenticate(header); return this.auth.logoutAll(user.id); }
  @Get('sessions') async sessions(@Headers('authorization') header: string) { const user = await this.auth.authenticate(header); return this.auth.sessions(user.id); }
  @Post('sessions/revoke') async revokeSession(@Body() d: RevokeSessionDto, @Headers('authorization') header: string) { const user = await this.auth.authenticate(header); return this.auth.revokeSession(user.id, d.session_id); }
  @Post('email/verify') verifyEmail(@Body() d: VerifyEmailDto) { return this.auth.verifyEmail(d.token); }
  @Post('password/reset/request') resetRequest(@Body() d: PasswordResetRequestDto) { return this.auth.requestPasswordReset(d.email); }
  @Post('password/reset/confirm') resetConfirm(@Body() d: PasswordResetConfirmDto) { return this.auth.resetPassword(d); }
  @Post('invitations/accept') acceptInvitation(@Body() d: InvitationAcceptDto) { return this.auth.acceptInvitation(d); }
  @Get('me') me(@Headers('authorization') header: string) { return this.auth.authenticate(header); }
  @Patch('users/:id/disable') async disable(@Param('id', new ParseUUIDPipe()) id: string, @Headers('authorization') header: string) { const user = await this.auth.authenticate(header); if (!user.roles.includes('admin')) throw new ForbiddenException('Acceso administrativo requerido'); return this.auth.disable(id); }
  @Patch('users/:id/roles') async updateRoles(@Param('id', new ParseUUIDPipe()) id: string, @Body() d: UpdateRolesDto, @Headers('authorization') header: string, @Headers('x-correlation-id') correlationId?: string) { const user = await this.auth.authenticate(header); if (!user.roles.includes('admin')) throw new ForbiddenException('Acceso administrativo requerido'); return this.auth.updateRoles(id, d.roles, correlationId); }
  @Post('users/invite') async invite(@Body() d: InviteDto, @Headers('authorization') header: string) { const user = await this.auth.authenticate(header); if (!user.roles.includes('admin')) throw new ForbiddenException('Acceso administrativo requerido'); return this.auth.invite(d); }
  @Get('users') async listUsers(@Query('search') search: string | undefined, @Headers('authorization') header: string) { const user = await this.auth.authenticate(header); if (!user.roles.includes('admin')) throw new ForbiddenException('Acceso administrativo requerido'); return this.auth.listUsers(search); }
  @Post('producer-applications') async applyAsProducer(@Body() d: CreateProducerApplicationDto, @Headers('authorization') header: string) { const user = await this.auth.authenticate(header); return this.auth.createProducerApplication(user.id, d); }
  @Get('producer-applications/me') async myProducerApplication(@Headers('authorization') header: string) { const user = await this.auth.authenticate(header); return this.auth.myProducerApplication(user.id); }
  @Get('producer-applications') async listProducerApplications(@Headers('authorization') header: string) { const user = await this.auth.authenticate(header); if (!user.roles.includes('admin')) throw new ForbiddenException('Acceso administrativo requerido'); return this.auth.listProducerApplications(); }
  @Patch('producer-applications/:id') async reviewProducerApplication(@Param('id', new ParseUUIDPipe()) id: string, @Body() d: ReviewProducerApplicationDto, @Headers('authorization') header: string, @Headers('x-correlation-id') correlationId?: string) { const user = await this.auth.authenticate(header); if (!user.roles.includes('admin')) throw new ForbiddenException('Acceso administrativo requerido'); return this.auth.reviewProducerApplication(id, user.id, d.decision, d.review_notes, correlationId); }
  @Get('users/:id') async get(@Param('id', new ParseUUIDPipe()) id: string, @Headers('authorization') header: string) { const user = await this.auth.authenticate(header); if (user.id !== id && !user.roles.includes('admin')) throw new ForbiddenException('Acceso no permitido'); return this.auth['db'].user.findUnique({ where: { id }, select: { id: true, email: true, fullName: true, roles: true, status: true, createdAt: true } }); }
}
