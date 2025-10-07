import {
  IsString,
  IsOptional,
  IsArray,
  IsNumber,
  IsDateString,
} from 'class-validator';

export class CreateFocusSessionDto {
  @IsString()
  userId: string;

  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  plannedDuration?: number;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class UpdateFocusSessionDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  actualDuration?: number;

  @IsOptional()
  @IsDateString()
  endedAt?: Date;

  @IsOptional()
  @IsNumber()
  breaksTaken?: number;

  @IsOptional()
  @IsNumber()
  breakDuration?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsNumber()
  productivityRating?: number;
}
