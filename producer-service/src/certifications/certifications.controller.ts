import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseInterceptors, UploadedFile, StreamableFile, UnprocessableEntityException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response } from 'express';
import { createReadStream } from 'fs';
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
    @CurrentUser() user: AuthUser,
  ) {
    return this.certs.findByProducer(producerId, query, user);
  }
}

@Controller('certifications')
export class CertificationsController {
  constructor(private readonly certs: CertificationsService) {}

  @Get('pending/review')
  pending(@CurrentUser() user: AuthUser) { return this.certs.listPending(user); }

  @Get(':id')
  findOne(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthUser) {
    return this.certs.findOne(id, user);
  }

  @Post(':id/file')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 }, storage: memoryStorage() }))
  uploadFile(@Param('id', new ParseUUIDPipe()) id: string, @UploadedFile() file: Express.Multer.File, @CurrentUser() user: AuthUser) {
    if (!file) throw new UnprocessableEntityException('Debe adjuntar un archivo');
    return this.certs.attachFile(id, file, user);
  }

  @Get(':id/file')
  async download(@Param('id', new ParseUUIDPipe()) id: string, @Res({ passthrough: true }) res: Response, @CurrentUser() user: AuthUser) {
    const f = await this.certs.file(id, user);
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename="${f.name.replace(/"/g, '')}"`);
    return new StreamableFile(createReadStream(f.path));
  }

  @Patch(':id/verification')
  verify(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: { status: 'approved' | 'rejected'; notes?: string }, @CurrentUser() user: AuthUser) {
    if (!['approved', 'rejected'].includes(body.status)) throw new Error('status debe ser approved o rejected');
    return this.certs.verify(id, body.status, body.notes, user);
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
