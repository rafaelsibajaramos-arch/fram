import { IsIn, IsNumber, IsUUID, Min } from 'class-validator';
export class ReceiveDto { @IsUUID() batch_id!: string; @IsUUID() product_id!: string; @IsNumber() @Min(0.001) quantity_kg!: number; }
export class ReserveDto { @IsUUID() product_id!: string; @IsNumber() @Min(0.001) quantity_kg!: number; }
export class WasteDto { @IsUUID() lot_id!: string; @IsNumber() @Min(0.001) quantity_kg!: number; @IsIn(['expiry', 'damage', 'cold_chain']) reason!: 'expiry' | 'damage' | 'cold_chain'; @IsUUID() operation_id!: string; }
