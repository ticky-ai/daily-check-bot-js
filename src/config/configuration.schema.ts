import { IsString, IsNumber, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

export class ConfigurationSchema {
  @IsString()
  BOT_TOKEN: string;

  @IsOptional()
  @IsString()
  WEBHOOK_URL?: string;

  @IsString()
  DATABASE_URL: string;

  @IsOptional()
  @IsString()
  OPENAI_API_KEY?: string;

  @IsOptional()
  @IsString()
  NODE_ENV?: string = 'development';

  @IsOptional()
  @Transform(({ value }) => parseInt(value))
  @IsNumber()
  PORT?: number = 3000;

  @IsOptional()
  @IsString()
  LOG_LEVEL?: string = 'info';

  @IsOptional()
  @IsString()
  YOOKASSA_SHOP_ID?: string;

  @IsOptional()
  @IsString()
  YOOKASSA_SECRET_KEY?: string;

  @IsOptional()
  @IsString()
  REDIS_URL?: string;
}
