import { IsArray, IsNumber, IsOptional, IsString, IsUUID, Min, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class OrderItemDto {
  @IsUUID() productId!: string;
  @IsNumber() @Min(0.001) quantity!: number;
}
export class CreateOrderDto {
  @IsUUID() buyerId!: string;
  @IsString() deliveryAddress!: string;
  @IsArray() @ValidateNested({ each: true }) @Type(() => OrderItemDto) items!: OrderItemDto[];
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsString() idempotencyKey?: string;
}
export class CartItemDto {
  @IsUUID() productId!: string;
  @Transform(({ value }) => Number(value))
  @IsNumber() @Min(0.001) quantity!: number;
  // El precio del carrito es solo una referencia visual: Checkout siempre lo
  // reemplaza por el precio vigente de Catálogo en el servidor.
  @IsOptional() @Transform(({ value }) => value === null || value === '' ? undefined : Number(value)) @IsNumber() @Min(0) unitPrice?: number;
  @IsOptional() @IsUUID() priceVersionId?: string;
}
export class UpsertCartDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => CartItemDto) items!: CartItemDto[];
}
