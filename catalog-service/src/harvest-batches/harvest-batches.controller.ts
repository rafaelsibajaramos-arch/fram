import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CorrelationId } from '../common/correlation.decorator';
import { CreateHarvestBatchDto } from './dto/create-harvest-batch.dto';
import { QueryHarvestBatchesDto } from './dto/query-harvest-batches.dto';
import { UpdateHarvestBatchDto } from './dto/update-harvest-batch.dto';
import { HarvestBatchesService } from './harvest-batches.service';

@Controller('harvest-batches')
export class HarvestBatchesController {
  constructor(private readonly batches: HarvestBatchesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateHarvestBatchDto, @CorrelationId() cid: string) {
    return this.batches.create(dto, cid);
  }

  @Get()
  findAll(@Query() query: QueryHarvestBatchesDto) {
    return this.batches.findAll(query);
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.batches.findOne(id);
  }

  @Patch(':id')
  update(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: UpdateHarvestBatchDto) {
    return this.batches.update(id, dto);
  }

  @Patch(':id/publish')
  publish(@Param('id', new ParseUUIDPipe()) id: string, @CorrelationId() cid: string) {
    return this.batches.publish(id, cid);
  }

  @Patch(':id/close')
  close(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.batches.close(id);
  }
}
