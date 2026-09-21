import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { AuthUser } from '../common/auth/jwt-auth.guard';
import { CertificationsService } from './certifications.service';
import { CreateCertificationDto } from './dto/create-certification.dto';
import { QueryCertificationsDto } from './dto/query-certifications.dto';
import { UpdateCertificationDto } from './dto/update-certification.dto';

@Controller('producers/:producerId/certifications')
export class ProducerCertificationsController {
  constructor(private readonly certs: CertificationsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Param('producerId', new ParseUUIDPipe()) producerId: string,
    @Body() dto: CreateCertificationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.certs.create(producerId, dto, user);
  }

  @Get()
  findAll(
    @Param('producerId', new ParseUUIDPipe()) producerId: string,
    @Query() query: QueryCertificationsDto,
  ) {
    return this.certs.findByProducer(producerId, query);
  }
}

@Controller('certifications')
export class CertificationsController {
  constructor(private readonly certs: CertificationsService) {}

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.certs.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCertificationDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.certs.update(id, dto, user);
  }

  @Patch(':id/revoke')
  revoke(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser) {
    return this.certs.revoke(id, user);
  }
}
