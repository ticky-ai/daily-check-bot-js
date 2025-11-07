import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';

export interface FreePlanLimits {
  habits: number;
  tasks: number;
  aiRequests: number;
  pomodoroSessions: number;
  dependencies: number;
}

export interface SubscriptionInfo {
  isPremium: boolean;
  limits: FreePlanLimits;
  usage: {
    habits: number;
    tasks: number;
    aiRequests: number;
    pomodoroSessions: number;
    dependencies: number;
  };
  resetDate: Date; // Дата сброса лимитов (ежедневно)
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  private readonly FREE_PLAN_LIMITS: FreePlanLimits = {
    habits: 3,
    tasks: 5,
    aiRequests: 5,
    pomodoroSessions: 3,
    dependencies: 1,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async getSubscriptionInfo(userId: string): Promise<SubscriptionInfo> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          habits: true,
          tasks: true,
          dependencySupport: { where: { status: 'ACTIVE' } },
        },
      });

      if (!user) {
        throw new Error(`User ${userId} not found`);
      }

      // Проверяем, нужно ли сбросить ежедневные лимиты
      await this.resetDailyLimitsIfNeeded(userId);

      // Получаем текущее использование
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const todayUsage = {
        habits: user.habits.length,
        tasks: user.tasks.length,
        aiRequests: (user as any).dailyAiRequests || 0,
        pomodoroSessions: (user as any).dailyPomodoroSessions || 0,
        dependencies: user.dependencySupport.length,
      };

      const nextReset = new Date(today);
      nextReset.setDate(nextReset.getDate() + 1);

      return {
        isPremium: (user as any).isPremium || false,
        limits: this.FREE_PLAN_LIMITS,
        usage: todayUsage,
        resetDate: nextReset,
      };
    } catch (error) {
      this.logger.error(
        `Error getting subscription info for user ${userId}:`,
        error,
      );
      throw error;
    }
  }

  async checkLimit(
    userId: string,
    type: keyof FreePlanLimits,
  ): Promise<{
    allowed: boolean;
    current: number;
    limit: number;
    remaining: number;
  }> {
    // Проверяем, является ли пользователь админом
    const adminIds = this.configService.get<string[]>('admin.ids') || [];
    const isAdmin = adminIds.includes(userId);

    // Админы имеют безлимитный доступ
    if (isAdmin) {
      return {
        allowed: true,
        current: 0,
        limit: -1, // Неограничено для админов
        remaining: -1,
      };
    }

    const subscriptionInfo = await this.getSubscriptionInfo(userId);

    if (subscriptionInfo.isPremium) {
      return {
        allowed: true,
        current: subscriptionInfo.usage[type],
        limit: -1, // Неограничено для премиум
        remaining: -1,
      };
    }

    const current = subscriptionInfo.usage[type];
    const limit = subscriptionInfo.limits[type];
    const remaining = Math.max(0, limit - current);

    return {
      allowed: current < limit,
      current,
      limit,
      remaining,
    };
  }

  async incrementUsage(
    userId: string,
    type: keyof FreePlanLimits,
  ): Promise<void> {
    try {
      // Проверяем, является ли пользователь админом
      const adminIds = this.configService.get<string[]>('admin.ids') || [];
      const isAdmin = adminIds.includes(userId);

      // Админы не увеличивают счетчики
      if (isAdmin) {
        return;
      }

      const subscriptionInfo = await this.getSubscriptionInfo(userId);

      if (subscriptionInfo.isPremium) {
        return; // Не нужно отслеживать для премиум пользователей
      }

      // Увеличиваем счетчик в зависимости от типа
      switch (type) {
        case 'aiRequests':
          await this.prisma.user.update({
            where: { id: userId },
            data: {
              dailyAiRequests: { increment: 1 },
            } as any,
          });
          break;
        case 'pomodoroSessions':
          await this.prisma.user.update({
            where: { id: userId },
            data: {
              dailyPomodoroSessions: { increment: 1 },
            } as any,
          });
          break;
        // Для habits, tasks, dependencies счетчик уже есть (количество записей)
      }

      this.logger.log(`Incremented ${type} usage for user ${userId}`);
    } catch (error) {
      this.logger.error(`Error incrementing usage for user ${userId}:`, error);
      throw error;
    }
  }

  private async resetDailyLimitsIfNeeded(userId: string): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user) return;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const lastReset = (user as any).lastDailyReset
        ? new Date((user as any).lastDailyReset)
        : null;

      // Если последний сброс был не сегодня, сбрасываем счетчики
      if (!lastReset || lastReset < today) {
        await this.prisma.user.update({
          where: { id: userId },
          data: {
            dailyAiRequests: 0,
            dailyPomodoroSessions: 0,
            lastDailyReset: today,
          } as any,
        });

        this.logger.log(`Reset daily limits for user ${userId}`);
      }
    } catch (error) {
      this.logger.error(
        `Error resetting daily limits for user ${userId}:`,
        error,
      );
    }
  }

  getLimitMessage(
    type: keyof FreePlanLimits,
    current: number,
    limit: number,
  ): string {
    const typeNames = {
      habits: 'привычек',
      tasks: 'задач',
      aiRequests: 'запросов к ИИ',
      pomodoroSessions: 'сессий помодоро',
      dependencies: 'зависимостей',
    };

    return `🚫 *Лимит достигнут*\n\nВы достигли лимита ${typeNames[type]} в бесплатной версии: ${current}/${limit}\n\n💎 **Получите Premium для:**\n• ♾️ Неограниченное количество ${typeNames[type]}\n• 🚀 Все функции без ограничений\n• ⚡ Приоритетная поддержка`;
  }

  getUsageInfo(
    current: number,
    limit: number,
    type: keyof FreePlanLimits,
  ): string {
    if (limit === -1) return '♾️ Безлимитно'; // Premium

    const typeNames = {
      habits: 'привычек',
      tasks: 'задач',
      aiRequests: 'запросов ИИ',
      pomodoroSessions: 'сессий помодоро',
      dependencies: 'зависимостей',
    };

    const remaining = Math.max(0, limit - current);
    return `${current}/${limit} ${typeNames[type]} (осталось: ${remaining})`;
  }

  async showSubscriptionStatus(ctx: any): Promise<void> {
    try {
      // Проверяем, является ли пользователь админом
      const adminIds = this.configService.get<string[]>('admin.ids') || [];
      const isAdmin = adminIds.includes(ctx.userId);

      if (isAdmin) {
        await ctx.replyWithMarkdown(
          `👑 **Администратор**\n\n♾️ Все функции без ограничений!\n🚀 Полный доступ ко всем возможностям бота!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
        return;
      }

      const info = await this.getSubscriptionInfo(ctx.userId);

      let message = info.isPremium
        ? `💎 **Premium статус активен**\n\n♾️ Все функции без ограничений!\n🚀 Спасибо за поддержку!`
        : `🆓 **Бесплатная версия**\n\n📊 **Текущее использование:**\n`;

      if (!info.isPremium) {
        message += `🎯 Привычки: ${this.getUsageInfo(info.usage.habits, info.limits.habits, 'habits')}\n`;
        message += `📝 Задачи: ${this.getUsageInfo(info.usage.tasks, info.limits.tasks, 'tasks')}\n`;
        message += `🤖 ИИ запросы: ${this.getUsageInfo(info.usage.aiRequests, info.limits.aiRequests, 'aiRequests')}\n`;
        message += `🍅 Помодоро: ${this.getUsageInfo(info.usage.pomodoroSessions, info.limits.pomodoroSessions, 'pomodoroSessions')}\n`;
        message += `🎭 Зависимости: ${this.getUsageInfo(info.usage.dependencies, info.limits.dependencies, 'dependencies')}\n\n`;
        message += `🔄 Лимиты обновятся: ${info.resetDate.toLocaleDateString('ru-RU')}\n\n`;
        message += `💎 **Premium преимущества:**\n`;
        message += `• ♾️ Неограниченные привычки и задачи\n`;
        message += `• 🤖 Безлимитные запросы к ИИ\n`;
        message += `• 🍅 Безлимитные сессии фокуса\n`;
        message += `• 🎭 Неограниченные зависимости\n`;
        message += `• ⚡ Приоритетная поддержка\n`;
      }

      await ctx.replyWithMarkdown(message, {
        reply_markup: {
          inline_keyboard: info.isPremium
            ? [[{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }]]
            : [
                [{ text: '💎 Получить Premium', callback_data: 'get_premium' }],
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
        },
      });
    } catch (error) {
      this.logger.error(`Error showing subscription status:`, error);
      await ctx.replyWithMarkdown(
        '❌ Ошибка при загрузке информации о подписке',
      );
    }
  }
}
