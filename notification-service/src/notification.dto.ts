import { IsBoolean, IsIn, IsString, MaxLength, Matches } from 'class-validator';

export class SetNotificationPreferenceDto {
  @IsString() @Matches(/^[a-z][a-z0-9_.-]{2,59}$/) notification_type!: string;
  @IsIn(['email', 'sms', 'in_app']) channel!: 'email' | 'sms' | 'in_app';
  @IsBoolean() enabled!: boolean;
}

export class NotificationQueryDto {
  @IsString() @MaxLength(20) limit?: string;
}
