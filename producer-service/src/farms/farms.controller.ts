import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { AuthUser } from '../common/auth/jwt-auth.guard';
import { CreateFarmDto } from './dto/create-farm.dto';
import { QueryFarmsDto } from './dto/query-farms.dto';
import { UpdateFarmDto } from './dto/update-farm.dto';
import { FarmsService } from './farms.service';

/** Rutas anidadas: POST/GET /producers/:id/farms */
@Controller('producers/:producerId/farms')
export class ProducerFarmsController {
  constructor(private readonly farms: FarmsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('producerId', new ParseUUIDPipe()) producerId: string,
    @Body() dto: CreateFarmDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.farms.create(producerId, dto, user);
  }

  @Get()
  findAll(@Param('producerId', new ParseUUIDPipe()) producerId: string, @Query() query: QueryFarmsDto, @CurrentUser() user: AuthUser) {
    return this.farms.findByProducer(producerId, query, user);
  }
}

/** Rutas planas: GET/PATCH /farms/:id */
@Controller('farms')
export class FarmsController {
  constructor(private readonly farms: FarmsService) {}

  @Get(':farmId')
  findOne(@Param('farmId', new ParseUUIDPipe()) farmId: string, @CurrentUser() user: AuthUser) {
    return this.farms.findOne(farmId, user);
  }

  @Patch(':farmId')
  update(
    @Param('farmId', new ParseUUIDPipe()) farmId: string,
    @Body() dto: UpdateFarmDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.farms.update(farmId, dto, user);
  }

  @Patch(':farmId/enable')
  enable(@Param('farmId', new ParseUUIDPipe()) farmId: string, @CurrentUser() user: AuthUser) {
    return this.farms.setActive(farmId, true, user);
  }

  @Patch(':farmId/disable')
  disable(@Param('farmId', new ParseUUIDPipe()) farmId: string, @CurrentUser() user: AuthUser) {
    return this.farms.setActive(farmId, false, user);
  }
}
