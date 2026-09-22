import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CorrelationId } from '../common/correlation.decorator';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { AuthUser } from '../common/auth/jwt-auth.guard';
import { CreateHarvestBatchDto } from './dto/create-harvest-batch.dto';
import { QueryHarvestBatchesDto } from './dto/query-harvest-batches.dto';
import { UpdateHarvestBatchDto } from './dto/update-harvest-batch.dto';
import { HarvestBatchesService } from './harvest-batches.service';

@Controller('harvest-batches')
export class HarvestBatchesController {
  constructor(private readonly batches: HarvestBatchesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateHarvestBatchDto, @CurrentUser() user: AuthUser, @CorrelationId() cid: string) {
    return this.batches.create(dto, user, cid);
  }

  @Get()
  findAll(@Query() query: QueryHarvestBatchesDto, @CurrentUser() user: AuthUser) {
    return this.batches.findAll(query, user);
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @CorrelationId() cid: string) {
    return this.batches.findOne(id, user, cid);
  }

  @Patch(':id')
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateHarvestBatchDto, @CurrentUser() user: AuthUser, @CorrelationId() cid: string) {
    return this.batches.update(id, dto, user, cid);
  }

  @Patch(':id/publish')
  publish(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @CorrelationId() cid: string) {
    return this.batches.publish(id, user, cid);
  }

  @Patch(':id/close')
  close(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @CorrelationId() cid: string) {
    return this.batches.close(id, user, cid);
  }
}
