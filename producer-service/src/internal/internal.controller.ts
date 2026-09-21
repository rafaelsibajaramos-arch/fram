import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { InternalAuthGuard } from '../common/auth/internal-auth.guard';
import { Public } from '../common/auth/public.decorator';
import { FarmsService } from '../farms/farms.service';
import { ProducersService } from '../producers/producers.service';

/**
 * Rutas servicio-a-servicio usadas por catalog-service.
 * No son publicas, no pasan por el API Gateway y no devuelven informacion
 * innecesaria: solo existencia y estado.
 */
@Public()
@UseGuards(InternalAuthGuard)
@Controller('internal')
export class InternalController {
  constructor(
    private readonly producers: ProducersService,
    private readonly farms: FarmsService,
  ) {}

  @Get('producers/:producerId/validate')
  validateProducer(@Param('producerId', new ParseUUIDPipe()) producerId: string) {
    return this.producers.validate(producerId);
  }

  @Get('farms/:farmId/validate')
  validateFarm(@Param('farmId', new ParseUUIDPipe()) farmId: string) {
    return this.farms.validate(farmId);
  }
}
