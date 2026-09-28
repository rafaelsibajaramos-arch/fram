import { IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
export class CreatePaymentDto { @IsUUID() orderId!: string; @IsUUID() buyerId!: string; @IsNumber() @Min(0.01) amount!: number; @IsOptional() @IsString() currency?: string; @IsOptional() @IsString() provider?: string; @IsOptional() @IsString() idempotencyKey?: string; }
