import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class CreateUserDto {
  @IsString()
  id: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;
}

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  firstName?: string;

  @IsOptional()
  @IsString()
  lastName?: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsBoolean()
  onboardingPassed?: boolean;

  @IsOptional()
  @IsBoolean()
  feedbackGiven?: boolean;
}

export class UpdateUserStatsDto {
  @IsOptional()
  totalTasks?: number;

  @IsOptional()
  completedTasks?: number;

  @IsOptional()
  totalHabits?: number;

  @IsOptional()
  completedHabits?: number;

  @IsOptional()
  todayTasks?: number;

  @IsOptional()
  todayHabits?: number;

  @IsOptional()
  xpGained?: number;
}
