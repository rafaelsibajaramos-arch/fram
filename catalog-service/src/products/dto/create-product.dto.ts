import { Transform, Type } from 'class-transformer';
import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, IsUUID, MaxLength, Min } from 'class-validator';

/** Dentro de este alcance todos los productos se venden en kg. */
export const UNIDAD_UNICA = 'kg';

export class CreateProductDto {
  /** REF externa a producer_db: se valida por REST contra producer-service. */
  @IsUUID('4', { message: 'producer_id debe ser un UUID valido' })
  producer_id!: string;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value))
  @IsNotEmpty({ message: 'name no puede estar vacio' })
  @MaxLength(150)
  name!: string;

  @IsUUID('4', { message: 'category_id debe ser un UUID valido' })
  category_id!: string;

  @IsOptional()
  @IsIn([UNIDAD_UNICA], { message: 'unit solo puede ser kg' })
  unit?: string = UNIDAD_UNICA;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'min_order_quantity debe ser numerico' })
  @IsPositive({ message: 'min_order_quantity debe ser mayor que 0' })
  min_order_quantity!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'base_price debe ser numerico' })
  @IsPositive({ message: 'base_price debe ser mayor que 0' })
  base_price!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'low_stock_threshold debe ser numerico' })
  @Min(0, { message: 'low_stock_threshold debe ser mayor o igual a 0' })
  low_stock_threshold!: number;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 }, { message: 'high_stock_threshold debe ser numerico' })
  @Min(0, { message: 'high_stock_threshold debe ser mayor o igual a 0' })
  high_stock_threshold!: number;
}
