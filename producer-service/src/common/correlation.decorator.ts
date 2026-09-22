import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

export const CorrelationId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest();
  return req?.correlationId ?? randomUUID();
});
