import { IsEnum, IsOptional } from 'class-validator';
import { CertificationStatusDto } from './update-certification.dto';

export class QueryCertificationsDto {
  @IsOptional()
  @IsEnum(CertificationStatusDto, { message: 'status debe ser valid, expired o revoked' })
  status?: CertificationStatusDto;
}
