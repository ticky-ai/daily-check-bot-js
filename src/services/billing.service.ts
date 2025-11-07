import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { SubscriptionType } from '@prisma/client';

export interface UsageLimits {
  dailyReminders: number;
  dailyTasks: number;
  dailyHabits: number;
  dailyAiQueries: number;
  maxFocusSessions: number;
  advancedAnalytics: boolean;
  prioritySupport: boolean;
  customThemes: boolean;
}

@Injectable()
export class BillingService {
  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  private readonly SUBSCRIPTION_LIMITS: Record<SubscriptionType, UsageLimits> =
    {
      FREE: {
        dailyReminders: 5,
        dailyTasks: 10,
        dailyHabits: 3,
        dailyAiQueries: 10,
        maxFocusSessions: 3,
        advancedAnalytics: false,
        prioritySupport: false,
        customThemes: false,
      },
      PREMIUM: {
        dailyReminders: -1, // Unlimited
        dailyTasks: -1,
        dailyHabits: -1,
        dailyAiQueries: -1,
        maxFocusSessions: -1,
        advancedAnalytics: true,
        prioritySupport: true,
        customThemes: true,
      },
    };

  async getUserLimits(userId: string): Promise<UsageLimits> {
    // Проверяем, является ли пользователь админом
    const adminIds = this.configService.get<string[]>('admin.ids') || [];
    const isAdmin = adminIds.includes(userId);

    // Админы имеют безлимитный доступ
    if (isAdmin) {
      return this.SUBSCRIPTION_LIMITS.PREMIUM;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionType: true,
        isTrialActive: true,
        trialEnds: true,
      },
    });

    if (!user) {
      return this.SUBSCRIPTION_LIMITS.FREE;
    }

    // Check if trial is still active
    const now = new Date();
    const isTrialActive =
      user.isTrialActive && user.trialEnds && now < user.trialEnds;

    // During trial, give PREMIUM features
    if (isTrialActive) {
      return this.SUBSCRIPTION_LIMITS.PREMIUM;
    }

    return this.SUBSCRIPTION_LIMITS[user.subscriptionType];
  }

  async checkUsageLimit(
    userId: string,
    limitType: keyof UsageLimits,
  ): Promise<{
    allowed: boolean;
    current: number;
    limit: number;
    message?: string;
  }> {
    // Проверяем, является ли пользователь админом
    const adminIds = this.configService.get<string[]>('admin.ids') || [];
    const isAdmin = adminIds.includes(userId);

    // Админы имеют безлимитный доступ
    if (isAdmin) {
      return { allowed: true, current: 0, limit: -1 };
    }

    const limits = await this.getUserLimits(userId);
    const limit = limits[limitType] as number;

    // Unlimited access
    if (limit === -1) {
      return { allowed: true, current: 0, limit: -1 };
    }

    // Reset daily usage if needed
    await this.resetDailyUsageIfNeeded(userId);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        dailyRemindersUsed: true,
        dailyTasksUsed: true,
        dailyHabitsUsed: true,
        dailyAiQueriesUsed: true,
        subscriptionType: true,
        isTrialActive: true,
        trialEnds: true,
      },
    });

    if (!user) {
      return {
        allowed: false,
        current: 0,
        limit: 0,
        message: 'Пользователь не найден',
      };
    }

    let current = 0;
    let upgradeMessage = '';

    switch (limitType) {
      case 'dailyReminders':
        current = user.dailyRemindersUsed;
        upgradeMessage = 'напоминаний';
        break;
      case 'dailyTasks':
        current = user.dailyTasksUsed;
        upgradeMessage = 'задач';
        break;
      case 'dailyHabits':
        current = user.dailyHabitsUsed;
        upgradeMessage = 'привычек';
        break;
      case 'dailyAiQueries':
        current = user.dailyAiQueriesUsed;
        upgradeMessage = 'запросов к ИИ';
        break;
    }

    const allowed = current < limit;
    const message = allowed
      ? undefined
      : `🚫 Достигнут лимит ${upgradeMessage} (${limit}/день)\n\n` +
        `💎 Обновитесь до Premium для увеличения лимитов!`;

    return { allowed, current, limit, message };
  }

  async incrementUsage(
    userId: string,
    limitType: keyof UsageLimits,
  ): Promise<void> {
    // Проверяем, является ли пользователь админом
    const adminIds = this.configService.get<string[]>('admin.ids') || [];
    const isAdmin = adminIds.includes(userId);

    // Админы не увеличивают счетчики
    if (isAdmin) {
      return;
    }

    await this.resetDailyUsageIfNeeded(userId);

    const updateData: any = {};

    switch (limitType) {
      case 'dailyReminders':
        updateData.dailyRemindersUsed = { increment: 1 };
        break;
      case 'dailyTasks':
        updateData.dailyTasksUsed = { increment: 1 };
        break;
      case 'dailyHabits':
        updateData.dailyHabitsUsed = { increment: 1 };
        break;
      case 'dailyAiQueries':
        updateData.dailyAiQueriesUsed = { increment: 1 };
        break;
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.user.update({
        where: { id: userId },
        data: updateData,
      });
    }
  }

  async decrementUsage(
    userId: string,
    limitType: keyof UsageLimits,
  ): Promise<void> {
    await this.resetDailyUsageIfNeeded(userId);

    const updateData: any = {};

    switch (limitType) {
      case 'dailyReminders':
        updateData.dailyRemindersUsed = { decrement: 1 };
        break;
      case 'dailyTasks':
        updateData.dailyTasksUsed = { decrement: 1 };
        break;
      case 'dailyHabits':
        updateData.dailyHabitsUsed = { decrement: 1 };
        break;
      case 'dailyAiQueries':
        updateData.dailyAiQueriesUsed = { decrement: 1 };
        break;
    }

    if (Object.keys(updateData).length > 0) {
      await this.prisma.user.update({
        where: { id: userId },
        data: updateData,
      });
    }
  }

  async resetDailyUsageIfNeeded(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { lastUsageReset: true },
    });

    if (!user) return;

    const now = new Date();
    const lastReset = user.lastUsageReset;

    // Reset if it's a new day
    if (!lastReset || !this.isSameDay(now, lastReset)) {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          dailyRemindersUsed: 0,
          dailyTasksUsed: 0,
          dailyHabitsUsed: 0,
          dailyAiQueriesUsed: 0,
          lastUsageReset: now,
        },
      });
    }
  }

  private isSameDay(date1: Date, date2: Date): boolean {
    return (
      date1.getFullYear() === date2.getFullYear() &&
      date1.getMonth() === date2.getMonth() &&
      date1.getDate() === date2.getDate()
    );
  }

  async initializeTrialForUser(userId: string): Promise<void> {
    const now = new Date();
    const trialEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        isTrialActive: true,
        trialEnds: trialEnd,
        lastUsageReset: now,
      },
    });
  }

  async getTrialInfo(userId: string): Promise<{
    isTrialActive: boolean;
    daysRemaining: number;
    trialEnds?: Date;
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        isTrialActive: true,
        trialEnds: true,
      },
    });

    if (!user || !user.isTrialActive || !user.trialEnds) {
      return { isTrialActive: false, daysRemaining: 0 };
    }

    const now = new Date();
    const daysRemaining = Math.max(
      0,
      Math.ceil(
        (user.trialEnds.getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      ),
    );

    const isTrialActive = daysRemaining > 0;

    return {
      isTrialActive,
      daysRemaining,
      trialEnds: user.trialEnds,
    };
  }

  async getSubscriptionStatus(userId: string): Promise<{
    type: SubscriptionType;
    isActive: boolean;
    isTrialActive: boolean;
    daysRemaining: number;
    limits: UsageLimits;
    usage: {
      dailyReminders: number;
      dailyTasks: number;
      dailyHabits: number;
      dailyAiQueries: number;
    };
  }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        subscriptionType: true,
        isTrialActive: true,
        trialEnds: true,
        subscriptionEnds: true,
        dailyRemindersUsed: true,
        dailyTasksUsed: true,
        dailyHabitsUsed: true,
        dailyAiQueriesUsed: true,
      },
    });

    if (!user) {
      throw new Error('User not found');
    }

    const trialInfo = await this.getTrialInfo(userId);
    const limits = await this.getUserLimits(userId);

    const now = new Date();
    const isSubscriptionActive = user.subscriptionEnds
      ? now < user.subscriptionEnds
      : false;

    return {
      type: user.subscriptionType,
      isActive: isSubscriptionActive || trialInfo.isTrialActive,
      isTrialActive: trialInfo.isTrialActive,
      daysRemaining: trialInfo.daysRemaining,
      limits,
      usage: {
        dailyReminders: user.dailyRemindersUsed,
        dailyTasks: user.dailyTasksUsed,
        dailyHabits: user.dailyHabitsUsed,
        dailyAiQueries: user.dailyAiQueriesUsed,
      },
    };
  }
}
