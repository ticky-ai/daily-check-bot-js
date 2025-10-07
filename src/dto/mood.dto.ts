import {
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  IsNumber,
  IsBoolean,
} from 'class-validator';
import { MoodType } from '@prisma/client';

export class CreateMoodEntryDto {
  @IsString()
  userId: string;

  @IsEnum(MoodType)
  mood: MoodType;

  @IsOptional()
  @IsNumber()
  rating?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  emotions?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  factors?: string[];

  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;
}

export class UpdateMoodEntryDto {
  @IsOptional()
  @IsEnum(MoodType)
  mood?: MoodType;

  @IsOptional()
  @IsNumber()
  rating?: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  emotions?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  factors?: string[];

  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;
}
