import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    if (!request.user?.roles?.includes('admin')) throw new ForbiddenException('Solo administradores pueden consultar analítica');
    return true;
  }
}
