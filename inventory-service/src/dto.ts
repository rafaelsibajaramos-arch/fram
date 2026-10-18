import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNumber, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
export class ReceiveDto { @IsUUID() batch_id!: string; @IsUUID() product_id!: string; @IsNumber() @Min(0.001) quantity_kg!: number; }
export class ReserveDto { @IsUUID() product_id!: string; @IsNumber() @Min(0.001) quantity_kg!: number; @IsOptional() @IsString() @MaxLength(180) idempotency_key?: string; @IsOptional() @IsUUID() order_id?: string; @IsOptional() @IsUUID() order_item_id?: string; }
export class ConsumeBatchDto { @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('4', { each: true }) reservation_ids!: string[]; }
export class WasteDto { @IsUUID() lot_id!: string; @IsNumber() @Min(0.001) quantity_kg!: number; @IsIn(['expiry', 'damage', 'cold_chain']) reason!: 'expiry' | 'damage' | 'cold_chain'; @IsUUID() operation_id!: string; }
