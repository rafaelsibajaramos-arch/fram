import { IsArray, IsNumber, IsOptional, IsString, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class OrderItemDto {
  @IsUUID() productId!: string;
  @IsNumber() @Min(0.001) quantity!: number;
  @IsNumber() @Min(0) unitPrice!: number;
  @IsOptional() @IsUUID() priceVersionId?: string;
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
  @IsNumber() @Min(0.001) quantity!: number;
  @IsOptional() @IsNumber() @Min(0) unitPrice?: number;
  @IsOptional() @IsUUID() priceVersionId?: string;
}
export class UpsertCartDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => CartItemDto) items!: CartItemDto[];
}
