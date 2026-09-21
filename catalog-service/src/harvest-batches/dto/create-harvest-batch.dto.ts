import { Type } from 'class-transformer';
import { IsDateString, IsNumber, IsPositive, IsUUID } from 'class-validator';

export class CreateHarvestBatchDto {
  @IsUUID('4', { message: 'product_id debe ser un UUID valido' })
  product_id!: string;

  /** REF externa a producer_db: se valida por REST contra producer-service. */
  @IsUUID('4', { message: 'farm_id debe ser un UUID valido' })
  farm_id!: string;

  @IsDateString({}, { message: 'harvest_date debe tener formato YYYY-MM-DD' })
  harvest_date!: string;

  /** Cantidad inicial cosechada, no el saldo de inventario. */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'quantity_kg debe ser numerico' })
  @IsPositive({ message: 'quantity_kg debe ser mayor que 0' })
  quantity_kg!: number;

  @IsDateString({}, { message: 'expiry_estimate debe tener formato YYYY-MM-DD' })
  expiry_estimate!: string;
}
