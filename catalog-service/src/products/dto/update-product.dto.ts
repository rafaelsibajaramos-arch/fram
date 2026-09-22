import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, IsUUID, MaxLength, Min } from 'class-validator';

/**
 * producer_id y unit no son modificables: el dueno del producto no cambia y
 * la unidad siempre es kg.
 */
export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value))
  @IsNotEmpty({ message: 'name no puede estar vacio' })
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsUUID('4', { message: 'category_id debe ser un UUID valido' })
  category_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive({ message: 'min_order_quantity debe ser mayor que 0' })
  min_order_quantity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: 'base_price debe ser mayor que 0' })
  base_price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0, { message: 'low_stock_threshold debe ser mayor o igual a 0' })
  low_stock_threshold?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0, { message: 'high_stock_threshold debe ser mayor o igual a 0' })
  high_stock_threshold?: number;

  @IsOptional()
  @IsBoolean({ message: 'active debe ser true o false' })
  active?: boolean;
}
