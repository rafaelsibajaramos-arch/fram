import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

export const CORRELATION_HEADER = 'x-correlation-id';

declare module 'express-serve-static-core' {
  interface Request {
    correlationId?: string;
  }
}

/** Propaga correlation_id para poder rastrear una operacion distribuida. */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(CORRELATION_HEADER);
    const correlationId = isUuid(incoming) ? (incoming as string) : randomUUID();
    req.correlationId = correlationId;
    res.setHeader(CORRELATION_HEADER, correlationId);
    next();
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value?: string | null): boolean {
  return !!value && UUID_RE.test(value);
}
