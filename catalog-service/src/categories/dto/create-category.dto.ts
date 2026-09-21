import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Normaliza espacios internos y externos para evitar duplicados por formato. */
export const normalizarNombre = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value;

export class CreateCategoryDto {
  @IsString()
  @Transform(normalizarNombre)
  @IsNotEmpty({ message: 'name no puede estar vacio' })
  @MaxLength(80)
  name!: string;
}
