import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export enum ProducerStatusFilter {
  active = 'active',
  disabled = 'disabled',
}

export class QueryProducersDto extends PaginationDto {
  @IsOptional()
  @IsEnum(ProducerStatusFilter, { message: 'status debe ser active o disabled' })
  status?: ProducerStatusFilter;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(150)
  search?: string;
}
