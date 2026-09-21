import { Transform, Type } from 'class-transformer';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * producer_id no aparece aqui a proposito: no se permite cambiar arbitrariamente
 * el propietario de una finca. Un cambio real de propietario se hace con baja
 * logica y creando una nueva identidad de finca.
 */
export class UpdateFarmDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'farm_name no puede estar vacio' })
  @MaxLength(120)
  farm_name?: string;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'address no puede estar vacio' })
  address?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 }, { message: 'latitude debe ser numerica' })
  @Min(-90, { message: 'latitude debe estar entre -90 y 90' })
  @Max(90, { message: 'latitude debe estar entre -90 y 90' })
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 }, { message: 'longitude debe ser numerica' })
  @Min(-180, { message: 'longitude debe estar entre -180 y 180' })
  @Max(180, { message: 'longitude debe estar entre -180 y 180' })
  longitude?: number;
}
