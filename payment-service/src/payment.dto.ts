import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';
export class CreatePaymentDto { @IsUUID() orderId!: string; @IsUUID() buyerId!: string; @IsNumber() @Min(0.01) amount!: number; @IsUUID() simulatedCardId!: string; @IsOptional() @IsString() currency?: string; @IsOptional() @IsString() idempotencyKey?: string; }
export class CreateSimulatedCardDto { @IsIn(['Visa', 'Mastercard', 'American Express']) brand!: string; @IsString() @Length(2, 120) holderName!: string; }
export class TopUpWalletDto { @IsNumber() @Min(0.01) amount!: number; @IsString() reason!: string; @IsOptional() @IsString() idempotencyKey?: string; }
export class CompletePayoutDto { @IsString() providerReference!: string; }
