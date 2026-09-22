import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthUser } from './jwt-auth.guard';

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user ?? { sub: '', roles: [] };
});
