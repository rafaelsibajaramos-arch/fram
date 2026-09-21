import {
  ArgumentsHost,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

/** Traduce errores de Prisma a los codigos HTTP acordados (409 / 404 / 422). */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const mapped = this.toHttpException(exception);
    const status = mapped.getStatus();
    const body = mapped.getResponse();

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({
        msg: 'error no controlado',
        path: req.url,
        correlation_id: req.correlationId,
        error: exception instanceof Error ? exception.stack : String(exception),
      });
    }

    // Se conservan los campos extra que traiga la excepcion (por ejemplo los
    // 'checks' de /health/ready) en lugar de aplastar la respuesta.
    const detalle = typeof body === 'string' ? { message: body } : (body as Record<string, unknown>);

    res.status(status).json({
      ...detalle,
      statusCode: status,
      path: req.url,
      correlation_id: req.correlationId,
      timestamp: new Date().toISOString(),
    });
  }

  private toHttpException(exception: unknown): HttpException {
    if (exception instanceof HttpException) return exception;

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      switch (exception.code) {
        case 'P2002': {
          const target = (exception.meta?.target as string[] | undefined)?.join(', ') ?? 'recurso';
          return new ConflictException(`Ya existe un registro con ese valor unico (${target})`);
        }
        case 'P2003':
          return new ConflictException('Violacion de llave foranea');
        case 'P2025':
          return new NotFoundException('Registro no encontrado');
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return new HttpException('Datos invalidos para la operacion', HttpStatus.UNPROCESSABLE_ENTITY);
    }

    if (exception instanceof Prisma.PrismaClientInitializationError) {
      return new HttpException('Base de datos no disponible', HttpStatus.SERVICE_UNAVAILABLE);
    }

    return new HttpException('Error interno del servidor', HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
