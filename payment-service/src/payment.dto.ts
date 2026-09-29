import { IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
export class CreatePaymentDto { @IsUUID() orderId!: string; @IsUUID() buyerId!: string; @IsNumber() @Min(0.01) amount!: number; @IsOptional() @IsString() currency?: string; @IsOptional() @IsString() idempotencyKey?: string; }
export class TopUpWalletDto { @IsNumber() @Min(0.01) amount!: number; @IsString() reason!: string; @IsOptional() @IsString() idempotencyKey?: string; }
