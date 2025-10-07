import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsNumber,
  IsBoolean,
} from 'class-validator';
import { HabitFrequency } from '@prisma/client';

export class CreateHabitDto {
  @IsString()
  userId: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(HabitFrequency)
  frequency?: HabitFrequency;

  @IsOptional()
  @IsNumber()
  targetCount?: number;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  reminderTime?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  reminderDays?: string[];

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsNumber()
  difficulty?: number;

  @IsOptional()
  @IsNumber()
  xpReward?: number;
}

export class UpdateHabitDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(HabitFrequency)
  frequency?: HabitFrequency;

  @IsOptional()
  @IsNumber()
  targetCount?: number;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  reminderTime?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  reminderDays?: string[];

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @IsNumber()
  difficulty?: number;

  @IsOptional()
  @IsNumber()
  xpReward?: number;
}
