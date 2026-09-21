import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * id y user_id no son modificables mediante una actualizacion normal,
 * por eso no aparecen en este DTO (forbidNonWhitelisted los rechaza).
 */
export class UpdateProducerDto {
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'full_name no puede estar vacio' })
  @MaxLength(150)
  full_name?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'email invalido' })
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(/^\+?[0-9\s-]{7,24}$/, { message: 'phone invalido' })
  @MaxLength(25)
  phone?: string;
}
