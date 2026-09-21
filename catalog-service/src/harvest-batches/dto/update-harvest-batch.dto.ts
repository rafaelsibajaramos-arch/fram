import { Type } from 'class-transformer';
import { IsDateString, IsNumber, IsOptional, IsPositive } from 'class-validator';

/**
 * product_id y farm_id no se pueden reasignar: el origen de un lote es parte
 * de su trazabilidad.
 */
export class UpdateHarvestBatchDto {
  @IsOptional()
  @IsDateString({}, { message: 'harvest_date debe tener formato YYYY-MM-DD' })
  harvest_date?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive({ message: 'quantity_kg debe ser mayor que 0' })
  quantity_kg?: number;

  @IsOptional()
  @IsDateString({}, { message: 'expiry_estimate debe tener formato YYYY-MM-DD' })
  expiry_estimate?: string;
}
