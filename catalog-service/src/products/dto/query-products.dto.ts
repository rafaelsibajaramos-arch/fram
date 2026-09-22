import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

const aBooleano = ({ value }: { value: unknown }) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

export class QueryProductsDto extends PaginationDto {
  @IsOptional()
  @IsUUID('4', { message: 'producer_id debe ser un UUID valido' })
  producer_id?: string;

  @IsOptional()
  @IsUUID('4', { message: 'category_id debe ser un UUID valido' })
  category_id?: string;

  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean({ message: 'active debe ser true o false' })
  active?: boolean;

  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'min_price debe ser numerico' })
  @Min(0)
  min_price?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'max_price debe ser numerico' })
  @Min(0)
  max_price?: number;

  /** available=true devuelve solo productos con disponibilidad conocida > 0. */
  @IsOptional()
  @Transform(aBooleano)
  @IsBoolean({ message: 'available debe ser true o false' })
  available?: boolean;
}
