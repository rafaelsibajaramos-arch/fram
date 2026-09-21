import { Transform } from 'class-transformer';
import { IsDateString, IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export enum CertificationStatusDto {
  valid = 'valid',
  expired = 'expired',
  revoked = 'revoked',
}

export class UpdateCertificationDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'type no puede estar vacio' })
  @MaxLength(60)
  type?: string;

  @IsOptional()
  @IsDateString({}, { message: 'issue_date debe tener formato YYYY-MM-DD' })
  issue_date?: string;

  @IsOptional()
  @IsDateString({}, { message: 'valid_until debe tener formato YYYY-MM-DD' })
  valid_until?: string | null;

  @IsOptional()
  @IsEnum(CertificationStatusDto, { message: 'status debe ser valid, expired o revoked' })
  status?: CertificationStatusDto;
}
