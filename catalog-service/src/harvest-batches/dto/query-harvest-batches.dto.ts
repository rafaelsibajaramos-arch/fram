import { IsDateString, IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export enum BatchStatusFilter {
  registered = 'registered',
  published = 'published',
  closed = 'closed',
}

export class QueryHarvestBatchesDto extends PaginationDto {
  @IsOptional()
  @IsUUID('4', { message: 'product_id debe ser un UUID valido' })
  product_id?: string;

  @IsOptional()
  @IsUUID('4', { message: 'farm_id debe ser un UUID valido' })
  farm_id?: string;

  @IsOptional()
  @IsEnum(BatchStatusFilter, { message: 'status debe ser registered, published o closed' })
  status?: BatchStatusFilter;

  @IsOptional()
  @IsDateString({}, { message: 'harvest_date debe tener formato YYYY-MM-DD' })
  harvest_date?: string;

  /** Devuelve lotes cuyo vencimiento estimado es menor o igual a esta fecha. */
  @IsOptional()
  @IsDateString({}, { message: 'expiry_estimate debe tener formato YYYY-MM-DD' })
  expiry_estimate?: string;
}
