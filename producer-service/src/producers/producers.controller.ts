import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AuthUser } from '../common/auth/jwt-auth.guard';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { CorrelationId } from '../common/correlation.decorator';
import { CreateProducerDto } from './dto/create-producer.dto';
import { QueryProducersDto } from './dto/query-producers.dto';
import { UpdateProducerDto } from './dto/update-producer.dto';
import { ProducersService } from './producers.service';

@Controller('producers')
export class ProducersController {
  constructor(private readonly producers: ProducersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateProducerDto, @CurrentUser() user: AuthUser, @CorrelationId() cid: string) {
    return this.producers.create(dto, user, cid);
  }

  @Get()
  findAll(@Query() query: QueryProducersDto, @CurrentUser() user: AuthUser) {
    return this.producers.findAll(query, user);
  }

  /** Atajo para que un usuario encuentre su propio perfil. */
  @Get('by-user/:userId')
  findByUser(@Param('userId', new ParseUUIDPipe()) userId: string, @CurrentUser() user: AuthUser) {
    return this.producers.findByUserId(userId, user);
  }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser) {
    return this.producers.findOne(id, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateProducerDto,
    @CurrentUser() user: AuthUser,
    @CorrelationId() cid: string,
  ) {
    return this.producers.update(id, dto, user, cid);
  }

  @Patch(':id/enable')
  enable(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @CorrelationId() cid: string) {
    return this.producers.enable(id, user, cid);
  }

  @Patch(':id/disable')
  disable(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser, @CorrelationId() cid: string) {
    return this.producers.disable(id, user, cid);
  }
}
