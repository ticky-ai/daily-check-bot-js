import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { User } from '@prisma/client';
import { CreateUserDto, UpdateUserStatsDto } from '../dto';

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);

  constructor(private readonly prisma: PrismaService) {}

  async findByTelegramId(telegramId: string): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { id: telegramId },
    });

    if (!user) {
      throw new Error(`User with Telegram ID ${telegramId} not found`);
    }

    return user;
  }

  async findOrCreateUser(userData: CreateUserDto): Promise<User> {
    try {
      // Try to find existing user
      let user = await this.prisma.user.findUnique({
        where: { id: userData.id },
      });

      if (user) {
        // Update user info if needed
        const updateData: Partial<User> = {};
        let hasUpdates = false;

        if (userData.username !== user.username) {
          updateData.username = userData.username;
          hasUpdates = true;
        }
        if (userData.firstName !== user.firstName) {
          updateData.firstName = userData.firstName;
          hasUpdates = true;
        }
        if (userData.lastName !== user.lastName) {
          updateData.lastName = userData.lastName;
          hasUpdates = true;
        }

        if (hasUpdates) {
          updateData.lastActivity = new Date();
          user = await this.prisma.user.update({
            where: { id: userData.id },
            data: updateData,
          });
          this.logger.debug(`Updated user info for ${userData.id}`);
        }

        return user;
      }

      // Create new user
      user = await this.prisma.user.create({
        data: {
          id: userData.id,
          username: userData.username,
          firstName: userData.firstName,
          lastName: userData.lastName,
          onboardingPassed: false, // Явно устанавливаем, что онбординг не пройден
          lastActivity: new Date(),
          referralCode: this.generateReferralCode(),
        },
      });

      this.logger.log(`Created new user: ${userData.id}`);
      return user;
    } catch (error) {
      this.logger.error(`Error in findOrCreateUser for ${userData.id}:`, error);
      throw error;
    }
  }

  async updateUser(telegramId: string, updates: Partial<User>): Promise<User> {
    const updateData = {
      ...updates,
      lastActivity: new Date(),
    };

    return await this.prisma.user.update({
      where: { id: telegramId },
      data: updateData,
    });
  }

  async updateStats(
    telegramId: string,
    stats: {
      todayTasks?: number;
      todayHabits?: number;
      xpGained?: number;
    },
  ): Promise<{ user: User; leveledUp?: boolean; newLevel?: number }> {
    const user = await this.findByTelegramId(telegramId);
    const updateData: Partial<User> = {};

    if (stats.todayTasks !== undefined) {
      updateData.todayTasks = stats.todayTasks;
    }
    if (stats.todayHabits !== undefined) {
      updateData.todayHabits = stats.todayHabits;
    }

    let levelUpInfo: { leveledUp?: boolean; newLevel?: number } = {};

    if (stats.xpGained !== undefined) {
      const newTotalXp = user.totalXp + stats.xpGained;
      updateData.totalXp = newTotalXp;

      // Check for level up
      const newLevel = this.calculateLevel(newTotalXp);
      if (newLevel > user.level) {
        updateData.level = newLevel;
        levelUpInfo = { leveledUp: true, newLevel };
        this.logger.log(`User ${telegramId} leveled up to ${newLevel}!`);
      }
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: telegramId },
      data: updateData,
    });

    return { user: updatedUser, ...levelUpInfo };
  }

  async updateStreak(telegramId: string, streakValue: number): Promise<User> {
    const user = await this.findByTelegramId(telegramId);

    const updateData: Partial<User> = {
      currentStreak: streakValue,
    };

    if (streakValue > user.maxStreak) {
      updateData.maxStreak = streakValue;
    }

    return await this.prisma.user.update({
      where: { id: telegramId },
      data: updateData,
    });
  }

  async completeOnboarding(telegramId: string): Promise<User> {
    return await this.prisma.user.update({
      where: { id: telegramId },
      data: { onboardingPassed: true },
    });
  }

  async getUsersByReferralCode(referralCode: string): Promise<User[]> {
    return await this.prisma.user.findMany({
      where: { referralCode },
    });
  }

  async getUserStats(telegramId: string): Promise<{
    user: User;
    completionRate: number;
    habitCompletionRate: number;
    averageMood: number;
    focusTimeToday: number;
  }> {
    const user = await this.findByTelegramId(telegramId);

    // Calculate completion rates
    const completionRate =
      user.totalTasks > 0 ? (user.completedTasks / user.totalTasks) * 100 : 0;

    const habitCompletionRate =
      user.totalHabits > 0
        ? (user.completedHabits / user.totalHabits) * 100
        : 0;

    // TODO: Add mood and focus time calculations when those services are implemented
    const averageMood = 0;
    const focusTimeToday = 0;

    return {
      user,
      completionRate: Math.round(completionRate),
      habitCompletionRate: Math.round(habitCompletionRate),
      averageMood,
      focusTimeToday,
    };
  }

  private generateReferralCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  private calculateLevel(totalXp: number): number {
    // Simple level calculation: level = floor(sqrt(totalXp / 100)) + 1
    return Math.floor(Math.sqrt(totalXp / 100)) + 1;
  }

  // Helper method to get display name
  getDisplayName(user: User): string {
    if (user.firstName && user.lastName) {
      return `${user.firstName} ${user.lastName}`;
    } else if (user.firstName) {
      return user.firstName;
    } else if (user.username) {
      return `@${user.username}`;
    } else {
      return `User ${user.id}`;
    }
  }

  // Helper methods for XP and level calculations
  getCurrentLevelXp(user: User): number {
    return (user.level - 1) * 100 + 50 * (user.level - 1) * (user.level - 1);
  }

  getNextLevelXp(user: User): number {
    return user.level * 100 + 50 * user.level * user.level;
  }

  getProgressXp(user: User): number {
    return Math.max(0, user.totalXp - this.getCurrentLevelXp(user));
  }

  getXpToNextLevel(user: User): number {
    return Math.max(0, this.getNextLevelXp(user) - user.totalXp);
  }

  getLevelProgressRatio(user: User): number {
    const xpNeeded = this.getNextLevelXp(user) - this.getCurrentLevelXp(user);
    if (xpNeeded <= 0) {
      return 1.0;
    }
    return Math.min(1.0, this.getProgressXp(user) / xpNeeded);
  }
}
