import { IsArray, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class RegisterDto { @IsEmail() email!: string; @IsString() @MinLength(10) password!: string; @IsString() @IsNotEmpty() full_name!: string; }
export class LoginDto { @IsEmail() email!: string; @IsString() @MinLength(1) password!: string; @IsOptional() @IsString() device_name?: string; }
export class RefreshDto { @IsString() @MinLength(32) refresh_token!: string; @IsOptional() @IsString() device_name?: string; }
export class VerifyEmailDto { @IsString() @MinLength(32) token!: string; }
export class PasswordResetRequestDto { @IsEmail() email!: string; }
export class PasswordResetConfirmDto { @IsString() @MinLength(32) token!: string; @IsString() @MinLength(10) password!: string; }
export class InviteDto { @IsEmail() email!: string; @IsString() @IsNotEmpty() full_name!: string; @IsArray() @IsIn(['buyer', 'producer'], { each: true }) roles!: string[]; }
export class InvitationAcceptDto { @IsString() @MinLength(32) token!: string; @IsString() @MinLength(10) password!: string; }
export class DisableDto { @IsOptional() @IsString() reason?: string; }
export class UpdateRolesDto { @IsArray() @IsIn(['buyer', 'producer'], { each: true }) roles!: string[]; }
export class RevokeSessionDto { @IsUUID() session_id!: string; }
