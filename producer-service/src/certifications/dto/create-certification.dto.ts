import { Transform } from 'class-transformer';
import { IsDateString, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateCertificationDto {
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'type no puede estar vacio' })
  @MaxLength(60)
  type!: string;

  @IsDateString({}, { message: 'issue_date debe tener formato YYYY-MM-DD' })
  issue_date!: string;

  /** NULL / ausente = certificacion sin caducidad. */
  @IsOptional()
  @IsDateString({}, { message: 'valid_until debe tener formato YYYY-MM-DD' })
  valid_until?: string | null;
}
