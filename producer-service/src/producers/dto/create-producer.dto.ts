import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

const normalizarEmail = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class CreateProducerDto {
  /** REF a Identity. Debe coincidir con JWT.sub salvo que quien llame sea admin. */
  @IsUUID('4', { message: 'user_id debe ser un UUID valido' })
  user_id!: string;

  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsNotEmpty({ message: 'full_name no puede estar vacio' })
  @MaxLength(150)
  full_name!: string;

  @Transform(normalizarEmail)
  @IsEmail({}, { message: 'email invalido' })
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(/^\+?[0-9\s-]{7,24}$/, { message: 'phone invalido' })
  @MaxLength(25)
  phone?: string;
}
