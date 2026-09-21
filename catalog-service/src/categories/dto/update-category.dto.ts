import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { normalizarNombre } from './create-category.dto';

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @Transform(normalizarNombre)
  @IsNotEmpty({ message: 'name no puede estar vacio' })
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsBoolean({ message: 'active debe ser true o false' })
  active?: boolean;
}
