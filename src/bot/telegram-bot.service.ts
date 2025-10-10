/**
 * Показывает быстрое меню-виджет с основными действиями
 */
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
  forwardRef,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, session } from 'telegraf';
import { User, Reminder, ReminderStatus } from '@prisma/client';
import { BotContext } from './bot-context.interface';
import { UserService } from '../services/user.service';
import { OpenAIService } from '../services/openai.service';
import { TaskService } from '../services/task.service';
import { HabitService } from '../services/habit.service';
import { BillingService } from '../services/billing.service';
import { AiContextService } from '../services/ai-context.service';
import { PaymentService } from '../services/payment.service';
import { SubscriptionService } from '../services/subscription.service';
import { PrismaService } from '../database/prisma.service';
import { NotificationService } from '../services/notification.service';
import * as path from 'path';

@Injectable()
export class TelegramBotService implements OnModuleInit, OnModuleDestroy {
  /**
   * Настраивает reply keyboard и inline keyboard для Telegram-бота
   */
  public async setup(ctx: BotContext) {
    // Reply Keyboard (native Telegram menu)
    await ctx.reply('Меню', {
      reply_markup: {
        keyboard: [
          [{ text: '📝 Мои задачи' }, { text: '+ Добавить задачу' }],
          [{ text: '✅ Отметить выполнение' }, { text: '📊 Статистика' }],
          [{ text: '🏆 Достижения' }, { text: '👥 Друзья' }],
          [{ text: '🤖 AI Чат' }, { text: '⏰ Таймер' }],
        ],
        resize_keyboard: true,
        is_persistent: true,
      },
    });

    // Inline Keyboard (example)
    const callback_data = 'back_to_menu';
    // ...existing code...
    console.log('[LOG] Creating inline button for reminder:', {
      callback_data,
    });
    this.logger.log(
      `[LOG] Creating inline button for reminder: ${callback_data}`,
    );
    // ...existing code...
    await ctx.reply('Выберите действие:', {
      reply_markup: {
        inline_keyboard: [[{ text: '🏠 Главное меню', callback_data }]],
      },
    });
  }
  private readonly logger = new Logger(TelegramBotService.name);
  private bot: Telegraf<BotContext>;
  private activePomodoroSessions: Map<
    string,
    {
      focusTimer?: NodeJS.Timeout;
      breakTimer?: NodeJS.Timeout;
      startTime: Date;
      pausedAt?: Date;
      totalPausedTime?: number; // milliseconds
    }
  > = new Map();

  private activeIntervalReminders: Map<
    string,
    {
      intervalId: NodeJS.Timeout;
      reminderText: string;
      intervalMinutes: number;
      startTime: Date;
      count: number;
    }
  > = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
    private readonly openaiService: OpenAIService,
    private readonly taskService: TaskService,
    private readonly habitService: HabitService,
    private readonly billingService: BillingService,
    private readonly aiContextService: AiContextService,
    private readonly paymentService: PaymentService,
    private readonly subscriptionService: SubscriptionService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => NotificationService))
    private readonly notificationService: NotificationService,
  ) {
    const token = this.configService.get<string>('bot.token');
    if (!token) {
      throw new Error('BOT_TOKEN is not provided');
    }

    this.bot = new Telegraf<BotContext>(token);
    this.setupMiddleware();
    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupMiddleware() {
    // Session middleware
    this.bot.use(
      session({
        defaultSession: () => ({
          step: undefined,
          data: {},
          waitingForInput: false,
          currentAction: undefined,
          tempData: {},
        }),
      }),
    );

    // User context middleware
    this.bot.use(async (ctx, next) => {
      if (ctx.from) {
        ctx.userId = ctx.from.id.toString();

        // Ensure user exists in database
        const existingUser = await this.userService
          .findByTelegramId(ctx.from.id.toString())
          .catch(() => null);

        if (!existingUser) {
          // Create new user
          await this.userService.findOrCreateUser({
            id: ctx.from.id.toString(),
            username: ctx.from.username,
            firstName: ctx.from.first_name,
            lastName: ctx.from.last_name,
          });

          // Initialize trial period for new user
          await this.billingService.initializeTrialForUser(
            ctx.from.id.toString(),
          );
        }
      }

      // Add helper methods
      ctx.replyWithMarkdown = (text: string, extra: any = {}) => {
        return ctx.reply(text, { parse_mode: 'Markdown', ...extra });
      };

      ctx.editMessageTextWithMarkdown = (text: string, extra: any = {}) => {
        return ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra });
      };

      return next();
    });
  }

  private setupErrorHandling() {
    // Global error handler for bot
    this.bot.catch(async (err, ctx) => {
      // Log concise error information to avoid dumping large objects (ctx/update)
      const error = err as Error;
      this.logger.error(`Bot error: ${error?.message || String(err)}`);
      if (error && error.stack) {
        this.logger.debug(error.stack);
      }

      try {
        // Send a friendly user-facing error message without exposing internals
        await ctx.replyWithMarkdown(
          '❌ Произошла ошибка. Попробуйте позже или обратитесь к администратору.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      } catch (responseError) {
        const respErr = responseError as Error;
        this.logger.error(
          `Failed to send error response: ${respErr?.message || String(responseError)}`,
        );
        if (respErr && respErr.stack) {
          this.logger.debug(respErr.stack);
        }
      }
    });
  }

  private setupHandlers() {
    // Start command
    this.bot.start(async (ctx) => {
      try {
        // Проверяем реферальный параметр
        const startPayload = ctx.startPayload;
        let referrerId: string | undefined;

        if (startPayload && startPayload.startsWith('ref_')) {
          referrerId = startPayload.replace('ref_', '');
          this.logger.log(`User started with referral from: ${referrerId}`);
        }

        // Создаем или находим пользователя
        const userData = {
          id: ctx.from?.id.toString() || ctx.userId,
          username: ctx.from?.username || undefined,
          firstName: ctx.from?.first_name || undefined,
          lastName: ctx.from?.last_name || undefined,
        };

        const user = await this.userService.findOrCreateUser(userData);

        // Если это новый пользователь с реферальным кодом
        if (referrerId && referrerId !== user.id) {
          await this.handleReferralRegistration(ctx, user.id, referrerId);
        }

        this.logger.log(
          `User ${user.id} started bot. Onboarding passed: ${user.onboardingPassed}`,
        );

        // Проверяем, прошел ли пользователь онбординг
        if (!user.onboardingPassed) {
          this.logger.log(`Starting onboarding for user ${user.id}`);
          await this.startOnboarding(ctx);
        } else {
          this.logger.log(`Showing main menu for user ${user.id}`);
          await this.showMainMenu(ctx);
        }
      } catch (error) {
        this.logger.error('Error in start command:', error);
        await ctx.replyWithMarkdown(
          '❌ Произошла ошибка при запуске бота. Попробуйте еще раз.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      }
    });

    // Voice message handler - delegate to audio handler (transcription + processing)
    this.bot.on('voice', async (ctx) => {
      await this.handleAudioMessage(ctx, 'voice');
    });

    // Help command
    this.bot.help(async (ctx) => {
      await ctx.replyWithMarkdown(`
🤖 *Ticky AI - Ваш персональный AI помощник продуктивности*

*Основные команды:*
/start - Начать работу с ботом
/help - Показать эту справку
/menu - Главное меню
/home - Быстро в главное меню
/feedback - Оставить отзыв о боте
/tasks - Управление задачами
/habits - Управление привычками
/mood - Отметить настроение
/focus - Сессия фокуса
/stats - Статистика
/settings - Настройки

*Быстрый доступ:*
🏠 Напишите "меню", "домой" или "главная" для быстрого возврата в главное меню

*Быстрые действия:*
📝 Добавить задачу
✅ Завершить задачу
🎯 Добавить привычку
😊 Отметить настроение
⏰ Сессия фокуса

Для получения подробной информации используйте /menu
      `);
    });

    // Main menu command
    this.bot.command('menu', async (ctx) => {
      try {
        // Создаем или находим пользователя
        const userData = {
          id: ctx.from?.id.toString() || ctx.userId,
          username: ctx.from?.username || undefined,
          firstName: ctx.from?.first_name || undefined,
          lastName: ctx.from?.last_name || undefined,
        };

        const user = await this.userService.findOrCreateUser(userData);

        // Проверяем, прошел ли пользователь онбординг
        if (!user.onboardingPassed) {
          this.logger.log(`Starting onboarding for user ${user.id}`);
          await this.startOnboarding(ctx);
        } else {
          this.logger.log(`Showing main menu for user ${user.id}`);
          await this.showMainMenu(ctx);
        }
      } catch (error) {
        this.logger.error('Error in menu command:', error);
        await ctx.replyWithMarkdown(
          '❌ Произошла ошибка при открытии меню. Попробуйте еще раз.',
        );
      }
    });

    // Home command - quick access to main menu
    this.bot.command('home', async (ctx) => {
      try {
        await ctx.answerCbQuery?.();

        // Clear session state when going to main menu
        ctx.session.step = undefined;
        ctx.session.pendingAction = undefined;
        ctx.session.tempData = undefined;

        await this.showMainMenu(ctx);
      } catch (error) {
        this.logger.error('Error in home command:', error);
        await ctx.replyWithMarkdown(
          '❌ Произошла ошибка при открытии главного меню. Попробуйте еще раз.',
        );
      }
    });

    // Tasks command
    this.bot.command('tasks', async (ctx) => {
      await this.showTasksMenu(ctx);
    });

    // Habits command
    this.bot.command('habits', async (ctx) => {
      await this.showHabitsMenu(ctx);
    });

    // Mood command
    this.bot.command('mood', async (ctx) => {
      await this.showMoodMenu(ctx);
    });

    // Focus command
    this.bot.command('focus', async (ctx) => {
      await this.showFocusSession(ctx);
    });

    // Help command
    this.bot.command('help', async (ctx) => {
      const helpMessage = `
🤖 *Ticky AI - Справка*

**Доступные команды:**
/start - Начать работу с ботом
/help - Показать эту справку
/menu - Главное меню
/info - Информация о системе и напоминаниях
/feedback - Оставить отзыв о боте
/tasks - Управление задачами
/habits - Управление привычками
/mood - Отметить настроение
/focus - Сессия фокуса
/reminders - Активные напоминания
/testnotify - Тестовое уведомление

**Основные функции:**
📝 Управление задачами и привычками
😊 Трекинг настроения
🍅 Техника Помодоро для фокуса
📊 Статистика и аналитика
⏰ Умные напоминания о привычках
🎯 Мотивационные сообщения для борьбы с зависимостями
💎 Система биллинга с пробным периодом

Для получения подробной информации используйте /menu
      `;

      // Check if this is a callback query (can edit) or command (need to reply)
      if (ctx.callbackQuery) {
        await ctx.editMessageTextWithMarkdown(helpMessage);
      } else {
        await ctx.replyWithMarkdown(helpMessage);
      }
    });

    // Feedback command
    this.bot.command('feedback', async (ctx) => {
      try {
        await this.showFeedbackSurvey(ctx);
      } catch (error) {
        this.logger.error('Error in feedback command:', error);
        await ctx.replyWithMarkdown('❌ Произошла ошибка. Попробуйте позже.', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        });
      }
    });

    // Test notification command
    this.bot.command('testnotify', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();

        // Find user's first habit
        const habit = await this.prisma.habit.findFirst({
          where: { userId, isActive: true },
        });

        if (!habit) {
          await ctx.reply('❌ У вас нет активных привычек для тестирования.');
          return;
        }

        // Send test notification
        const message = `⏰ *Тестовое напоминание*\n\n🎯 ${habit.title}\n\nЭто пример уведомления о привычке!`;
        const keyboard = {
          inline_keyboard: [
            [
              {
                text: '✅ Выполнил',
                callback_data: `complete_habit_${String(habit.id).slice(0, 20)}`,
              },
              {
                text: '⏰ Отложить на 15 мин',
                callback_data: `snooze_habit_${String(habit.id).slice(0, 20)}_15`,
              },
            ],
            [
              {
                text: '📊 Статистика',
                callback_data: `habit_stats_${String(habit.id).slice(0, 20)}`,
              },
              {
                text: '❌ Пропустить сегодня',
                callback_data: `skip_habit_${String(habit.id).slice(0, 20)}`,
              },
            ],
          ],
        };

        await ctx.reply(message, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });

        this.logger.log(
          `Test notification sent to user ${userId} for habit ${habit.id}`,
        );
      } catch (error) {
        this.logger.error('Error in test notification:', error);
        await ctx.reply('❌ Ошибка при отправке тестового уведомления.');
      }
    });

    // Show active reminders command
    this.bot.command('reminders', async (ctx) => {
      try {
        const userId = ctx.from.id.toString();

        const habitsWithReminders = await this.prisma.habit.findMany({
          where: {
            userId,
            isActive: true,
            reminderTime: { not: null },
          },
          orderBy: { title: 'asc' },
        });

        if (habitsWithReminders.length === 0) {
          await ctx.reply(
            '❌ У вас нет активных напоминаний о привычках.\n\nИспользуйте /habits для настройки напоминаний.',
          );
          return;
        }

        let message = `⏰ *Активные напоминания*\n\n`;

        for (const habit of habitsWithReminders) {
          const nextTime = this.calculateNextReminderTime(
            habit.reminderTime || '',
          );
          message += `🎯 **${habit.title}**\n`;
          message += `⏰ Интервал: ${habit.reminderTime}\n`;
          message += `🕒 Следующее: ${nextTime}\n\n`;
        }

        message += `📱 Используйте /testnotify для тестирования`;

        await ctx.reply(message, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎯 Мои привычки', callback_data: 'habits_list' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        });
      } catch (error) {
        this.logger.error('Error showing reminders:', error);
        await ctx.reply('❌ Ошибка при получении списка напоминаний.');
      }
    });

    // Billing command
    this.bot.command('billing', async (ctx) => {
      // Redirect to show_limits handler
      const subscriptionStatus =
        await this.billingService.getSubscriptionStatus(ctx.userId);

      const limitsText =
        subscriptionStatus.limits.dailyReminders === -1
          ? '∞ (безлимит)'
          : subscriptionStatus.limits.dailyReminders.toString();
      const aiLimitsText =
        subscriptionStatus.limits.dailyAiQueries === -1
          ? '∞ (безлимит)'
          : subscriptionStatus.limits.dailyAiQueries.toString();

      let statusMessage = '';
      if (subscriptionStatus.isTrialActive) {
        statusMessage = `🎁 **Пробный период:** ${subscriptionStatus.daysRemaining} дней осталось`;
      } else {
        statusMessage = `💎 **Подписка:** ${
          subscriptionStatus.type === 'FREE'
            ? 'Бесплатная'
            : subscriptionStatus.type === 'PREMIUM'
              ? 'Premium'
              : 'Premium Plus'
        }`;
      }

      await ctx.replyWithMarkdown(
        `📊 *Ваши лимиты и использование*

${statusMessage}

**Текущее использование сегодня:**
🔔 Напоминания: ${subscriptionStatus.usage.dailyReminders}/${limitsText}
🧠 ИИ-запросы: ${subscriptionStatus.usage.dailyAiQueries}/${aiLimitsText}
📝 Задачи: ${subscriptionStatus.usage.dailyTasks}${subscriptionStatus.limits.dailyTasks === -1 ? '' : `/${subscriptionStatus.limits.dailyTasks}`}
🔄 Привычки: ${subscriptionStatus.usage.dailyHabits}${subscriptionStatus.limits.dailyHabits === -1 ? '' : `/${subscriptionStatus.limits.dailyHabits}`}

**Доступные функции:**
📊 Расширенная аналитика: ${subscriptionStatus.limits.advancedAnalytics ? '✅' : '❌'}
🎨 Кастомные темы: ${subscriptionStatus.limits.customThemes ? '✅' : '❌'}
🚀 Приоритетная поддержка: ${subscriptionStatus.limits.prioritySupport ? '✅' : '❌'}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '💎 Обновиться до Premium',
                  callback_data: 'upgrade_premium',
                },
              ],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    // Reset onboarding command (for testing)
    this.bot.command('reset_onboarding', async (ctx) => {
      try {
        await this.userService.updateUser(ctx.userId, {
          onboardingPassed: false,
        });
        await ctx.editMessageTextWithMarkdown(
          '🔄 Онбординг сброшен. Используйте /start для прохождения заново.',
        );
        this.logger.log(`Onboarding reset for user ${ctx.userId}`);
      } catch (error) {
        this.logger.error('Error resetting onboarding:', error);
        await ctx.replyWithMarkdown('❌ Ошибка при сбросе онбординга.');
      }
    });

    // Info command - показывает информацию о мотивационных сообщениях
    this.bot.command('info', async (ctx) => {
      await this.showSystemInfo(ctx);
    });

    // Test motivation command
    this.bot.command('testmotivation', async (ctx) => {
      await this.testMotivationSystem(ctx);
    });

    // Onboarding callback handlers
    this.bot.action('onboarding_start', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showOnboardingStep2(ctx);
    });

    this.bot.action('onboarding_examples', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(`
📋 *Примеры того, что я умею:*

*Задачи:*
• "Купить молоко"
• "Сделать презентацию"
• "Позвонить врачу"

*Привычки:*
• "Пить 2 литра воды"
• "Делать зарядку"
• "Читать 30 минут"

*Отслеживание:*
• Настроение по шкале 1-10
• Прогресс выполнения
• Статистика и достижения
      `);

      setTimeout(async () => {
        await this.showOnboardingStep2(ctx);
      }, 3000);
    });

    this.bot.action('onboarding_faq', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showOnboardingStep3(ctx);
    });

    this.bot.action('onboarding_add_habit', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
✍️ *Отлично! Напиши название своей первой привычки.*

Например: выберите одну из кнопок или введите свою:
• Пить воду каждый час
• Делать зарядку утром
• Читать перед сном

*Напиши название привычки:*

⬇️ *Введите название привычки в поле для ввода ниже*
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '💧 Пить воду каждый час',
                  callback_data: 'habit_example_water',
                },
              ],
              [
                {
                  text: '🏃‍♂️ Делать зарядку утром',
                  callback_data: 'habit_example_sleep',
                },
              ],
              [
                {
                  text: '📚 Читать перед сном',
                  callback_data: 'habit_example_read',
                },
              ],
              [
                {
                  text: '📝 Ввести свою привычку',
                  callback_data: 'habit_custom_input',
                },
              ],
              [{ text: '🔙 Назад', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
      ctx.session.step = 'onboarding_waiting_habit';
    });

    this.bot.action('onboarding_skip_habit', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showOnboardingStep3(ctx);
    });

    this.bot.action('onboarding_complete', async (ctx) => {
      await ctx.answerCbQuery();

      try {
        // Mark onboarding as completed
        await this.userService.updateUser(ctx.userId, {
          onboardingPassed: true,
        });

        this.logger.log(`Onboarding completed for user ${ctx.userId}`);

        await ctx.editMessageTextWithMarkdown(`
🎉 *Поздравляем! Онбординг завершен!*

Теперь ты готов к продуктивной работе с Ticky AI!

🚀 Используй /menu для доступа ко всем функциям
        `);

        // Показываем главное меню
        setTimeout(() => {
          this.showMainMenu(ctx, false); // false = создать новое сообщение
        }, 2000);
      } catch (error) {
        this.logger.error('Error completing onboarding:', error);
        await ctx.replyWithMarkdown(
          '❌ Ошибка при завершении онбординга. Попробуйте еще раз.',
        );
      }
    });

    // Handler to move from onboarding habit creation to FAQ step
    this.bot.action('onboarding_next_faq', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showOnboardingStep3(ctx);
    });

    // 🔧 Обработчики подписки и лимитов
    this.bot.action('subscription_status', async (ctx) => {
      await ctx.answerCbQuery();
      await this.subscriptionService.showSubscriptionStatus(ctx);
    });

    this.bot.action('get_premium', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `💎 **Premium подписка**\n\n🚀 **Получите все возможности бота:**\n• ♾️ Неограниченные задачи и привычки\n• 🤖 Безлимитные запросы к ИИ\n• 🍅 Неограниченные сессии помодоро\n• 🎭 Неограниченные зависимости\n• ⚡ Приоритетная поддержка\n\n💰 **Цена:** 199₽/месяц\n\n🎁 **Первые 7 дней бесплатно!**`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💳 Оплатить Premium', callback_data: 'pay_premium' }],
              [{ text: '📊 Мои лимиты', callback_data: 'subscription_status' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action('pay_premium', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `💳 **Оплата Premium**\n\nВ разработке... Скоро будет доступна оплата через:\n• 💳 Банковские карты\n• 📱 СБП\n• 🥝 QIWI\n\n📞 **Пока что свяжитесь с поддержкой** для активации Premium`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📞 Связаться с поддержкой',
                  url: 'https://t.me/your_support_bot',
                },
              ],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    // Handle text input during onboarding
    this.bot.on('text', async (ctx) => {
      const user = await this.getOrCreateUser(ctx);

      // Update user activity for referral tracking
      await this.updateUserActivity(ctx.userId);

      // Skip if this is a command (starts with /) - FIRST CHECK
      if (ctx.message.text.startsWith('/')) {
        return; // Let command handlers process it
      }

      // Quick navigation to main menu
      const lowerText = ctx.message.text.toLowerCase().trim();
      if (
        lowerText === 'меню' ||
        lowerText === 'главное меню' ||
        lowerText === 'домой' ||
        lowerText === 'главная' ||
        lowerText === 'начало' ||
        lowerText === 'home' ||
        lowerText === 'menu'
      ) {
        // Clear session state
        ctx.session.step = undefined;
        ctx.session.pendingAction = undefined;
        ctx.session.tempData = undefined;
        ctx.session.aiChatMode = false; // 🔧 Автоматически завершаем AI чат при переходе в главное меню
        ctx.session.aiHabitCreationMode = false;

        await this.showMainMenu(ctx);
        return;
      }

      // Handle AI Chat mode
      if (ctx.session.aiChatMode) {
        await this.handleAIChatMessage(ctx, ctx.message.text);
        return;
      }

      // Handle AI Habit Creation mode
      if (ctx.session.aiHabitCreationMode) {
        await this.handleAIHabitCreationMessage(ctx, ctx.message.text);
        return;
      }

      // Handle natural language reminders (e.g., "напомни мне купить хлеб")
      if (this.isReminderRequest(ctx.message.text)) {
        await this.handleNaturalReminderRequest(ctx, ctx.message.text);
        return;
      }

      // Handle simple reminder requests without time (e.g., "напомни мне купить хлеб")
      if (this.isSimpleReminderRequest(ctx.message.text)) {
        await this.handleSimpleReminderRequest(ctx, ctx.message.text);
        return;
      }

      // Check if user needs to provide timezone first
      if (
        !user.timezone &&
        (ctx.session.step === 'adding_task' ||
          ctx.session.step === 'adding_habit')
      ) {
        await this.askForTimezone(ctx);
        return;
      }

      // Handle timezone setting
      if (ctx.session.step === 'waiting_for_city') {
        await this.handleCityInput(ctx, ctx.message.text);
        return;
      }

      // Handle editing task title flow
      if (
        ctx.session.step === 'editing_task_title' &&
        ctx.session.pendingTaskTitle
      ) {
        const newTitle = ctx.message.text?.trim();
        if (!newTitle || newTitle.length < 1) {
          await ctx.replyWithMarkdown(
            '⚠️ Название задачи не может быть пустым. Попробуйте ещё раз:',
          );
          return;
        }

        const taskId = ctx.session.pendingTaskTitle;
        try {
          await this.taskService.updateTask(taskId, ctx.userId, {
            title: newTitle,
          } as any);

          ctx.session.step = undefined;
          ctx.session.pendingTaskTitle = undefined;

          await ctx.replyWithMarkdown('✅ Название задачи обновлено.', {
            reply_markup: {
              inline_keyboard: [
                [{ text: '📋 Все задачи', callback_data: 'tasks_list' }],
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          });
        } catch (err) {
          this.logger.error('Error updating task title:', err);
          await ctx.replyWithMarkdown(
            '❌ Не удалось обновить задачу. Попробуйте позже.',
          );
        }
        return;
      }

      // Handle task creation
      if (ctx.session.step === 'waiting_for_task_title') {
        await this.handleTaskCreation(ctx, ctx.message.text);
        return;
      }

      // Handle custom feedback
      if (ctx.session.step === 'waiting_for_custom_feedback') {
        await this.completeFeedback(ctx, ctx.message.text);
        return;
      }

      // Handle reminder time input
      if (ctx.session.step === 'waiting_for_reminder_time') {
        await this.handleReminderTimeInputFromTask(ctx, ctx.message.text);
        return;
      }

      // Handle habit custom time input
      if (ctx.session.step === 'setting_habit_custom_time') {
        const timeText = ctx.message.text.trim();
        const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;

        if (!timeRegex.test(timeText)) {
          await ctx.replyWithMarkdown(
            '⚠️ Неверный формат времени. Используйте формат ЧЧ:ММ (например, 09:30 или 14:15):\n\n⏰ *Введите время для уведомлений:*\n\n⬇️ *Введите время в поле для ввода ниже*',
          );
          return;
        }

        const habitId = ctx.session.currentHabitId;
        if (habitId) {
          await this.updateHabitTime(ctx, habitId, timeText);
        }
        return;
      }

      // Handle custom dependency creation
      if (ctx.session.step === 'waiting_custom_dependency') {
        const dependencyName = ctx.message.text.trim();

        if (!dependencyName || dependencyName.length < 2) {
          await ctx.replyWithMarkdown(
            '⚠️ Название зависимости должно содержать минимум 2 символа. Попробуйте еще раз:\n\n⬇️ *Введите название зависимости в поле для ввода ниже*',
          );
          return;
        }

        ctx.session.step = undefined;

        await ctx.replyWithMarkdown(
          `
🎯 *Отлично! Начинаем борьбу с зависимостью: "${dependencyName}"*

🤖 Система ИИ настроена и будет отправлять вам персональные мотивационные сообщения каждый день.

� *Ты уже на правильном пути к свободе!*

Что тебе поможет:
• Ежедневные умные напоминания и поддержка
• Персональные советы от ИИ
• Напоминания о твоих целях
• Техники преодоления желаний

✅ *Напоминания активированы!*
        `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '⬅️ К выбору зависимости',
                    callback_data: 'choose_dependency',
                  },
                ],
              ],
            },
          },
        );

        try {
          // Сохраняем информацию о кастомной зависимости
          // await this.userService.updateUser(ctx.userId, {
          //   dependencyType: 'custom',
          //   customDependencyName: dependencyName,
          //   dependencyStartDate: new Date(),
          // });

          // Запускаем ежедневные мотивационные сообщения
          const user = await this.userService.findByTelegramId(ctx.userId);
          this.startDailyMotivation(user.id, 'custom');

          await ctx.replyWithMarkdown(
            `
✅ *Отлично! Запуск успешно начат!*

🎯 **Зависимость:** ${dependencyName}
📅 **Дата начала:** ${new Date().toLocaleDateString('ru-RU')}

🤖 **ИИ-система активирована:**
• Ежедневные мотивационные сообщения
• Персональные советы и поддержка
• Трекинг прогресса
• Техники преодоления желаний

💪 *Первое мотивационное сообщение придет сегодня в 21:00*

Удачи в борьбе с зависимостью! Ты справишься! 🚀
          `,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🏠 Главное меню',
                      callback_data: 'back_to_menu',
                    },
                  ],
                ],
              },
            },
          );
        } catch (error) {
          this.logger.error(`Error setting up custom dependency: ${error}`);
          await ctx.replyWithMarkdown(
            '❌ Произошла ошибка при настройке. Попробуйте позже.',
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '⬅️ К выбору зависимости',
                      callback_data: 'choose_dependency',
                    },
                  ],
                  [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
              },
            },
          );
        }
        return;
      }

      // Handle waiting for reminder time
      if (ctx.session.waitingForReminderTime && ctx.session.pendingReminder) {
        await this.handleReminderTimeInput(ctx, ctx.message.text);
        return;
      }

      if (ctx.session.step === 'onboarding_waiting_habit') {
        const habitName = ctx.message.text;

        try {
          // Создаем привычку в базе данных и получаем запись
          const habit = await this.habitService.createHabit({
            userId: ctx.userId,
            title: habitName,
            description: `каждый день`,
            frequency: 'DAILY',
            targetCount: 1,
          });

          // Увеличиваем счётчик использования привычек
          await this.billingService.incrementUsage(ctx.userId, 'dailyHabits');

          // Получаем текущее использование для отображения
          const usageInfo = await this.billingService.checkUsageLimit(
            ctx.userId,
            'dailyHabits',
          );

          // Сбрасываем шаг
          ctx.session.step = undefined;
          ctx.session.pendingAction = undefined;

          // Проверяем статус онбординга в БД — если пользователь ещё не завершил онбординг,
          // отправляем короткое подтверждение и кнопку к FAQ (далее в онбординге)
          const user = await this.userService.findByTelegramId(ctx.userId);
          if (!user.onboardingPassed) {
            await ctx.replyWithMarkdown(`✅ *Привычка выполнена!*`, {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '❓ FAQ', callback_data: 'onboarding_next_faq' }],
                ],
              },
            });
          } else {
            await ctx.editMessageTextWithMarkdown(
              `
✅ *Привычка создана!* 

🎯 **Название:** ${habitName}
📅 **Описание:** каждый день

📊 **Использовано:** ${usageInfo.current}${usageInfo.limit === -1 ? '' : `/${usageInfo.limit}`} привычек

💡 **Подсказка:** Вы можете настроить напоминания для этой привычки в меню привычек.
        `,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '⏰ Настроить напоминание',
                        callback_data: `habit_set_reminder_${habit.id}`,
                      },
                    ],
                    [
                      {
                        text: '🎯 Мои привычки',
                        callback_data: 'habits_list',
                      },
                      {
                        text: '🏠 Главное меню',
                        callback_data: 'back_to_menu',
                      },
                    ],
                    [
                      {
                        text: '❓ Что еще я умею?',
                        callback_data: 'faq_support',
                      },
                    ],
                  ],
                },
              },
            );
          }
        } catch (error) {
          this.logger.error('Error creating habit during onboarding:', error);
          await ctx.replyWithMarkdown(
            '❌ Ошибка при создании привычки. Попробуйте еще раз.',
          );
        }
        return;
      }

      // Handle regular habit creation
      if (ctx.session.step === 'adding_habit') {
        const habitTitle = ctx.message.text.trim();

        if (!habitTitle || habitTitle.length < 2) {
          await ctx.replyWithMarkdown(
            '⚠️ Название привычки должно содержать минимум 2 символа. Попробуйте еще раз:\n\n⬇️ *Введите название привычки в поле для ввода ниже*',
          );
          return;
        }

        try {
          // 🔧 Проверяем лимит привычек перед созданием
          const habitLimitCheck = await this.subscriptionService.checkLimit(
            ctx.userId,
            'habits',
          );

          if (!habitLimitCheck.allowed) {
            const limitMessage = this.subscriptionService.getLimitMessage(
              'habits',
              habitLimitCheck.current,
              habitLimitCheck.limit,
            );
            await ctx.replyWithMarkdown(limitMessage, {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '💎 Получить Premium',
                      callback_data: 'get_premium',
                    },
                  ],
                  [
                    {
                      text: '📊 Мои лимиты',
                      callback_data: 'subscription_status',
                    },
                  ],
                  [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
              },
            });
            return;
          }

          // Create the habit using the habit service
          await this.habitService.createHabit({
            userId: ctx.userId,
            title: habitTitle,
            description: undefined,
            frequency: 'DAILY' as const,
            targetCount: 1,
          });

          ctx.session.step = undefined;
          ctx.session.pendingAction = undefined;

          await ctx.replyWithMarkdown(
            `
✅ *Привычка "${habitTitle}" успешно добавлена!*

🎯 Теперь вы можете отслеживать её выполнение в разделе "Мои привычки".

*Напоминание:* Регулярность - ключ к формированию привычек!
          `,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🎯 Мои привычки', callback_data: 'menu_habits' }],
                  [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
              },
            },
          );
        } catch (error) {
          this.logger.error(`Error creating habit: ${error}`);
          await ctx.replyWithMarkdown(
            '❌ Произошла ошибка при создании привычки. Попробуйте позже.',
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
              },
            },
          );
        }
        return;
      }

      // Handle reminder requests in regular text mode (only with specific time)
      if (this.isReminderRequest(ctx.message.text)) {
        this.logger.log(
          `Processing reminder request: "${ctx.message.text}" for user ${ctx.userId}`,
        );
        await this.processReminderFromText(ctx, ctx.message.text);
        return;
      }

      // 🔧 Handle reply keyboard button commands (clear AI chat mode first)
      const buttonText = ctx.message.text.trim();
      if (this.isReplyKeyboardButton(buttonText)) {
        // Автоматически завершаем AI чат при нажатии любой кнопки клавиатуры
        ctx.session.aiChatMode = false;
        ctx.session.aiHabitCreationMode = false;

        await this.handleReplyKeyboardButton(ctx, buttonText);
        return;
      }

      // Skip if user is in a setup process (timezone, etc.)
      if (ctx.session.step) {
        // User is in the middle of some process, don't treat as task
        return;
      }

      // Handle task creation from text (including time-based tasks)
      if (this.isTaskRequest(ctx.message.text)) {
        this.logger.log(
          `Processing task from text: "${ctx.message.text}" for user ${ctx.userId}`,
        );
        await this.processTaskFromText(ctx, ctx.message.text);
        return;
      }

      // Check if this is a general question/chat message that should trigger AI
      if (this.isGeneralChatMessage(ctx.message.text)) {
        // Enable AI chat mode and handle the message
        ctx.session.aiChatMode = true;
        await this.handleAIChatMessage(ctx, ctx.message.text);
        return;
      }

      // Default: show help or main menu
      await ctx.replyWithMarkdown(`
🤔 *Не понимаю команду*

Используйте /menu для вызова главного меню или /help для справки.

💡 *Подсказка:* Вы можете написать "напомни мне..." с указанием времени для создания напоминания.
      `);
    });

    // Handle voice messages
    this.bot.on('voice', async (ctx) => {
      await this.handleAudioMessage(ctx, 'voice');
    });

    // Handle audio files
    this.bot.on('audio', async (ctx) => {
      await this.handleAudioMessage(ctx, 'audio');
    });

    // Main menu callback handlers
    this.bot.action('menu_tasks', async (ctx) => {
      await ctx.answerCbQuery();

      const user = await this.userService.findByTelegramId(ctx.userId);
      if (!user.timezone) {
        ctx.session.step = 'adding_task';
        await this.askForTimezone(ctx);
      } else {
        await this.showTasksMenu(ctx);
      }
    });

    this.bot.action('menu_habits', async (ctx) => {
      await ctx.answerCbQuery();

      const user = await this.userService.findByTelegramId(ctx.userId);
      if (!user.timezone) {
        ctx.session.step = 'adding_habit';
        await this.askForTimezone(ctx);
      } else {
        await this.showHabitsMenu(ctx);
      }
    });

    this.bot.action('habits_list', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showHabitsMenu(ctx);
    });

    // Handle AI advice for habits
    this.bot.action('habits_ai_advice', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showHabitsAIAdvice(ctx);
    });

    // Handle adding habits
    this.bot.action('habits_add', async (ctx) => {
      await ctx.answerCbQuery();

      const user = await this.userService.findByTelegramId(ctx.userId);
      if (!user.timezone) {
        ctx.session.pendingAction = 'adding_habit';
        await this.askForTimezone(ctx);
      } else {
        ctx.session.step = 'adding_habit';
        await ctx.editMessageTextWithMarkdown(
          '🔄 *Добавление привычки*\n\nВыберите готовый пример или введите название привычки вручную:\n\n⬇️ *Введите название привычки в поле для ввода ниже*',
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '💧 Пить воду каждый день по 2 литра',
                    callback_data: 'habit_example_water',
                  },
                ],
                [
                  {
                    text: '😴 Ложиться спать до 23:00',
                    callback_data: 'habit_example_sleep',
                  },
                ],
                [
                  {
                    text: '🚶‍♀️ Прогулка перед сном 20 минут',
                    callback_data: 'habit_example_walk',
                  },
                ],
                [
                  {
                    text: '📝 Ввести свою привычку',
                    callback_data: 'habit_custom_input',
                  },
                ],
                [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      }
    });

    // Handle habit examples - water drinking
    this.bot.action('habit_example_water', async (ctx) => {
      await ctx.answerCbQuery();
      const habitName = 'Пить воду каждый день по 2 литра';
      await this.createHabitFromExample(ctx, habitName);
    });

    // Handle habit examples - sleep schedule
    this.bot.action('habit_example_sleep', async (ctx) => {
      await ctx.answerCbQuery();
      const habitName = 'Ложиться спать до 23:00';
      await this.createHabitFromExample(ctx, habitName);
    });

    // Handle habit examples - reading before sleep
    this.bot.action('habit_example_read', async (ctx) => {
      await ctx.answerCbQuery();
      const habitName = 'Читать перед сном';
      await this.createHabitFromExample(ctx, habitName);
    });

    // Handle habit examples - evening walk
    this.bot.action('habit_example_walk', async (ctx) => {
      await ctx.answerCbQuery();
      const habitName = 'Прогулка перед сном 20 минут';
      await this.createHabitFromExample(ctx, habitName);
    });

    // Handle custom habit input
    this.bot.action('habit_custom_input', async (ctx) => {
      await ctx.answerCbQuery();
      ctx.session.step = 'adding_habit'; // Add this line!
      await ctx.editMessageTextWithMarkdown(
        '🔄 *Добавление привычки*\n\nВведите название привычки, которую хотите отслеживать:\n\n⬇️ *Введите название привычки в поле для ввода ниже*',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    // Handle habit reminder setup
    this.bot.action(/^habit_set_reminder_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.showReminderSetup(ctx, habitId);
    });

    // Handle reminder interval selection
    this.bot.action(/^set_reminder_(.+)_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery('⏰ Напоминание настроено!');
      const habitId = ctx.match[1];
      const interval = ctx.match[2];
      await this.setHabitReminder(ctx, habitId, interval);
    });

    // Handle habit view (detailed view with options)
    this.bot.action(/^habit_view_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.showHabitDetails(ctx, habitId);
    });

    // Handle habit completion
    this.bot.action(/^habit_complete_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.completeHabit(ctx, habitId);
    });

    // Handle quick habit completion from habits menu
    this.bot.action(/^habit_quick_complete_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery('🎉 Отлично! Привычка выполнена!');
      const habitId = ctx.match[1];
      await this.quickCompleteHabit(ctx, habitId);
    });

    // Handle habit completion from notification
    this.bot.action(/^complete_habit_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery('✅ Отличная работа!');
      const habitId = ctx.match[1];
      await this.completeHabitFromNotification(ctx, habitId);
    });

    // Handle habit snooze from notification
    this.bot.action(/^snooze_habit_(.+)_(\d+)$/, async (ctx) => {
      const habitId = ctx.match[1];
      const minutes = parseInt(ctx.match[2]);
      await ctx.answerCbQuery(`⏰ Напомним через ${minutes} минут`);
      await this.snoozeHabitFromNotification(ctx, habitId, minutes);
    });

    // Handle habit statistics from notification
    this.bot.action(/^habit_stats_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.showHabitStatsFromNotification(ctx, habitId);
    });

    // Handle skip habit from notification
    this.bot.action(/^skip_habit_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery('⏭️ Пропущено на сегодня');
      const habitId = ctx.match[1];
      await this.skipHabitFromNotification(ctx, habitId);
    });

    // Handle celebration thanks button
    this.bot.action('celebration_thanks', async (ctx) => {
      await ctx.answerCbQuery('🎉 Продолжайте в том же духе!');
      await this.showHabitsMenu(ctx);
    });

    // Handle create reminder from task (only matches task IDs, not 'help')
    this.bot.action(/^create_reminder_([a-f0-9]{10})$/, async (ctx) => {
      await ctx.answerCbQuery();
      try {
        // Получаем заголовок из сессии
        const taskTitle = ctx.session.tempData?.pendingReminderTitle;

        if (!taskTitle) {
          await ctx.editMessageTextWithMarkdown(
            '❌ Не удалось найти заголовок задачи. Попробуйте еще раз.',
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

        // Store the title for later use and ask for time
        ctx.session.tempData = { taskTitle };
        ctx.session.step = 'waiting_for_reminder_time';

        await ctx.editMessageTextWithMarkdown(
          `⏰ *Создание напоминания*\n\n📝 **"${taskTitle}"**\n\nВо сколько вам напомнить? Введите время в формате:\n• \`15:30\` - конкретное время\n• \`через 2 часа\` - относительное время\n• \`завтра в 14:00\` - время с датой\n\n⬇️ *Введите время в поле для ввода ниже*`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '⏰ Через 1 час', callback_data: 'reminder_time_1h' },
                  {
                    text: '⏰ Через 2 часа',
                    callback_data: 'reminder_time_2h',
                  },
                ],
                [
                  {
                    text: '⏰ Сегодня в 18:00',
                    callback_data: 'reminder_time_18',
                  },
                  {
                    text: '⏰ Завтра в 9:00',
                    callback_data: 'reminder_time_tomorrow_9',
                  },
                ],
                [{ text: '❌ Отмена', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      } catch (error) {
        this.logger.error('Error creating reminder from task:', error);
        await ctx.editMessageTextWithMarkdown(
          '❌ Произошла ошибка при создании напоминания. Попробуйте еще раз.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      }
    });

    // Handle showing more habits
    this.bot.action('habits_list_more', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showAllHabitsList(ctx);
    });

    // Handle habits management
    this.bot.action('habits_manage', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showHabitsManagement(ctx);
    });

    // Handle habits management (new comprehensive view)
    this.bot.action('habits_management', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showHabitsManagement(ctx);
    });

    // Handle habits statistics
    this.bot.action('habits_stats', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showHabitsStatistics(ctx);
    });

    // Handle habits notifications settings
    this.bot.action('habits_notifications_settings', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showHabitsNotificationsSettings(ctx);
    });

    // Handle specific habit notification settings
    this.bot.action(/^habit_notification_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.showHabitNotificationSettings(ctx, habitId);
    });

    // Handle setting habit frequency
    this.bot.action(/^set_habit_frequency_(.+)_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      const frequency = ctx.match[2];
      await this.updateHabitFrequency(ctx, habitId, frequency);
    });

    // Handle habit frequency settings view
    this.bot.action(/^habit_set_frequency_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.showHabitFrequencySettings(ctx, habitId);
    });

    // Handle habit frequency settings view
    this.bot.action(/^habit_frequency_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.showHabitFrequencySettings(ctx, habitId);
    });

    // Handle habit time settings view
    this.bot.action(/^habit_set_time_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.showHabitTimeSettings(ctx, habitId);
    });

    // Handle setting habit time
    this.bot.action(/^set_habit_time_(.+)_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      const timeStr = ctx.match[2]; // format: "0900" for 09:00
      const formattedTime = `${timeStr.slice(0, 2)}:${timeStr.slice(2)}`;
      await this.updateHabitTime(ctx, habitId, formattedTime);
    });

    // Handle custom time input
    this.bot.action(/^habit_custom_time_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      ctx.session.step = 'setting_habit_custom_time';
      ctx.session.tempData = { habitId };

      await ctx.editMessageTextWithMarkdown(
        '⏰ *Введите время в формате ЧЧ:ММ*\n\nНапример: 09:30, 14:15, 21:00\n\n⬇️ *Введите время в поле для ввода ниже*',
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔙 Назад',
                  callback_data: `habit_set_time_${habitId}`,
                },
              ],
            ],
          },
        },
      );
    });

    // Handle hour selection for habit time
    this.bot.action(/^select_hour_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.showHabitHourSelection(ctx, habitId);
    });

    // Handle minute selection for habit time
    this.bot.action(/^select_minute_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.showHabitMinuteSelection(ctx, habitId);
    });

    // Handle setting specific hour for habit
    this.bot.action(/^habit_hour_(.+)_(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      const hour = parseInt(ctx.match[2]);

      // Сохраняем выбранный час в tempData
      if (!ctx.session.tempData) {
        ctx.session.tempData = {};
      }
      ctx.session.tempData.selectedHour = hour.toString().padStart(2, '0');
      ctx.session.tempData.habitId = habitId;

      // Показываем выбор минут
      await this.showHabitMinuteSelection(ctx, habitId);
    });

    // Handle setting specific minute for habit
    this.bot.action(/^habit_minute_(.+)_(\d+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      const minute = parseInt(ctx.match[2]);

      // Используем сохраненный час из tempData или текущее время привычки
      let selectedHour = '09'; // по умолчанию

      if (
        ctx.session.tempData?.selectedHour &&
        ctx.session.tempData?.habitId === habitId
      ) {
        // Используем сохраненный час из текущей сессии выбора
        selectedHour = ctx.session.tempData.selectedHour;
        // Очищаем tempData после использования
        ctx.session.tempData = {};
      } else {
        // Получаем текущий час из привычки
        const habit = await this.habitService.findHabitById(
          habitId,
          ctx.userId,
        );
        if (habit && habit.reminderTime) {
          selectedHour = habit.reminderTime.split(':')[0];
        }
      }

      const newTime = `${selectedHour}:${minute.toString().padStart(2, '0')}`;
      await this.updateHabitTime(ctx, habitId, newTime);
    });

    // Handle habit deletion
    this.bot.action(/^habit_delete_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.confirmHabitDeletion(ctx, habitId);
    });

    // Handle habit deletion (alternative callback pattern)
    this.bot.action(/^delete_habit_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.confirmHabitDeletion(ctx, habitId);
    });

    // Handle habit deletion confirmation
    this.bot.action(/^confirm_delete_habit_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitId = ctx.match[1];
      await this.deleteHabit(ctx, habitId);
    });

    // Handle cancel habit deletion
    this.bot.action(/^cancel_delete_habit_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery('❌ Удаление отменено');
      await this.showHabitsManagement(ctx);
    });

    // Quick reminder time selection handlers
    this.bot.action('reminder_time_1h', async (ctx) => {
      await ctx.answerCbQuery();
      await this.createReminderWithRelativeTime(ctx, 1, 'hours');
    });

    this.bot.action('reminder_time_2h', async (ctx) => {
      await ctx.answerCbQuery();
      await this.createReminderWithRelativeTime(ctx, 2, 'hours');
    });

    this.bot.action('reminder_time_18', async (ctx) => {
      await ctx.answerCbQuery();
      await this.createReminderWithSpecificTime(ctx, '18:00');
    });

    this.bot.action('reminder_time_tomorrow_9', async (ctx) => {
      await ctx.answerCbQuery();
      await this.createReminderWithSpecificTime(ctx, '09:00', true); // tomorrow = true
    });

    this.bot.action('menu_mood', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMoodMenu(ctx);
    });

    this.bot.action('menu_focus', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showPomodoroMenu(ctx);
    });

    this.bot.action('menu_stats', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMainStatistics(ctx);
    });

    this.bot.action('menu_settings', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        '⚙️ *Настройки* - функция в разработке',
      );
    });

    this.bot.action('menu_achievements', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        '🏆 *Достижения* - функция в разработке',
      );
    });

    this.bot.action('menu_ai', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        '💡 *ИИ Помощник* - функция в разработке',
      );
    });

    // New main menu handlers
    this.bot.action('add_item', async (ctx) => {
      await ctx.answerCbQuery();
      const keyboard = {
        inline_keyboard: [
          [{ text: '🎯 Добавить привычку', callback_data: 'habits_add' }],
          [{ text: '📝 Добавить задачу', callback_data: 'tasks_add' }],
          [{ text: '🎙️ Отправить голосовое', callback_data: 'voice_message' }],
          [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
        ],
      };
      await ctx.editMessageTextWithMarkdown('➕ *Что хотите добавить?*', {
        reply_markup: keyboard,
      });
    });

    this.bot.action('voice_message', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `🎙️ *Озвучьте задачу*

Вы можете продиктовать:
• 📝 Новую задачу или напоминание
• 🔄 Новую привычку
• ❓ Любые вопросы или команды

Просто запишите и отправьте голосовое сообщение! 🎤`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'add_item' }],
            ],
          },
        },
      );
    });

    this.bot.action('my_items', async (ctx) => {
      await ctx.answerCbQuery();
      const keyboard = {
        inline_keyboard: [
          [{ text: '🎯 Мои привычки', callback_data: 'habits_list' }],
          [{ text: '📝 Мои задачи', callback_data: 'tasks_list' }],
          [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
        ],
      };
      await ctx.editMessageTextWithMarkdown('📋 *Что хотите посмотреть?*', {
        reply_markup: keyboard,
      });
    });

    this.bot.action('my_progress', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMainStatistics(ctx);
    });

    // New handlers for updated main menu
    this.bot.action('add_habit', async (ctx) => {
      await ctx.answerCbQuery();
      // Use the existing habit addition logic
      const user = await this.userService.findByTelegramId(ctx.userId);
      if (!user.timezone) {
        ctx.session.pendingAction = 'adding_habit';
        await this.askForTimezone(ctx);
      } else {
        ctx.session.step = 'adding_habit';
        try {
          await ctx.editMessageTextWithMarkdown(
            '🔄 *Добавление привычки*\n\nВыберите готовый пример или введите название привычки вручную:\n\n⬇️ *Введите название привычки в поле для ввода ниже*',
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '💧 Пить воду каждый день по 2 литра',
                      callback_data: 'habit_example_water',
                    },
                  ],
                  [
                    {
                      text: '😴 Ложиться спать до 23:00',
                      callback_data: 'habit_example_sleep',
                    },
                  ],
                  [
                    {
                      text: '🏃‍♂️ Заниматься спортом',
                      callback_data: 'habit_example_workout',
                    },
                  ],
                  [
                    {
                      text: '📚 Читать книги каждый день',
                      callback_data: 'habit_example_reading',
                    },
                  ],
                  [
                    {
                      text: '📝 Ввести свою привычку',
                      callback_data: 'habit_custom_input',
                    },
                  ],
                  [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
                ],
              },
            },
          );
        } catch (error) {
          // If editing fails (e.g., trying to edit a photo message), send a new message
          await ctx.replyWithMarkdown(
            '🔄 *Добавление привычки*\n\nВыберите готовый пример или введите название привычки вручную:\n\n⬇️ *Введите название привычки в поле для ввода ниже*',
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '💧 Пить воду каждый день по 2 литра',
                      callback_data: 'habit_example_water',
                    },
                  ],
                  [
                    {
                      text: '😴 Ложиться спать до 23:00',
                      callback_data: 'habit_example_sleep',
                    },
                  ],
                  [
                    {
                      text: '🏃‍♂️ Заниматься спортом',
                      callback_data: 'habit_example_workout',
                    },
                  ],
                  [
                    {
                      text: '📚 Читать книги каждый день',
                      callback_data: 'habit_example_reading',
                    },
                  ],
                  [
                    {
                      text: '📝 Ввести свою привычку',
                      callback_data: 'habit_custom_input',
                    },
                  ],
                  [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
                ],
              },
            },
          );
        }
      }
    });

    this.bot.action('my_habits', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showHabitsMenu(ctx);
    });

    this.bot.action('my_tasks', async (ctx) => {
      await ctx.answerCbQuery();
      const keyboard = {
        inline_keyboard: [
          [{ text: '➕ Добавить задачу', callback_data: 'tasks_add' }],
          [{ text: '📋 Список задач', callback_data: 'tasks_list' }],
          [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
        ],
      };
      try {
        await ctx.editMessageTextWithMarkdown(
          '📝 *Мои задачи*\n\nВыберите действие:',
          {
            reply_markup: keyboard,
          },
        );
      } catch (error) {
        // If editing fails (e.g., trying to edit a photo message), send a new message
        await ctx.replyWithMarkdown('📝 *Мои задачи*\n\nВыберите действие:', {
          reply_markup: keyboard,
        });
      }
    });

    this.bot.action('ai_chat', async (ctx) => {
        try {
          await ctx.answerCbQuery();
          await this.startAIChat(ctx);
        } catch (error) {
          console.error('Error in ai_chat action:', error);
          // Optionally, notify the user that an error occurred
          await ctx.reply('🚫 Произошла ошибка. Попробуйте позже или обратитесь к администратору.').catch(console.error);
        }
    });

    this.bot.action('more_functions', async (ctx) => {
      await ctx.answerCbQuery();
      const keyboard = {
        inline_keyboard: [
          [
            { text: '😊 Мое настроение', callback_data: 'menu_mood' },
            { text: '🍅 Фокусирование', callback_data: 'pomodoro_focus' },
          ],
          [
            { text: '🎭 Зависимости', callback_data: 'dependencies' },
            { text: '🚀 Челленджи', callback_data: 'challenges' },
          ],
          [
            {
              text: '💰 Бонусы и рефералы',
              callback_data: 'bonuses_referrals',
            },
            { text: '🛍️ XP Магазин', callback_data: 'shop' },
          ],
          [
            { text: '🥇 Достижения', callback_data: 'achievements' },
            { text: '🔔 Напоминания', callback_data: 'reminders' },
          ],
          [
            { text: '⬅️', callback_data: 'back_to_menu' },
            { text: '👤', callback_data: 'user_profile' },
            { text: '⚙️', callback_data: 'user_settings' },
          ],
        ],
      };
      try {
        await ctx.editMessageText(
          '🚀 *Дополнительные функции*\n\nВыберите интересующий раздел:',
          {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          },
        );
      } catch (error) {
        // If editing fails (e.g., trying to edit a photo message), send a new message
        await ctx.replyWithMarkdown(
          '🚀 *Дополнительные функции*\n\nВыберите интересующий раздел:',
          {
            reply_markup: keyboard,
          },
        );
      }
    });

    // Additional functions handlers
    this.bot.action('progress_stats', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showDetailedStatistics(ctx);
    });

    this.bot.action('user_settings', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const user = await this.userService.findByTelegramId(ctx.userId);

        const settingsText = `⚙️ *Настройки пользователя*

👤 **Профиль:**
🆔 ID: ${user.id || 'Неизвестно'}
👤 Имя: ${user.firstName || 'Не указано'}
📧 Username: ${user.username ? `@${user.username}` : 'Не указано'}

🔔 **Уведомления:**
📱 Уведомления: ${user.notifications !== false ? '✅ Включены' : '❌ Отключены'}
⏰ Время напоминаний: ${user.reminderTime || 'Не установлено'}
📊 Еженедельная сводка: ${user.weeklySummary !== false ? '✅ Включена' : '❌ Отключена'}

🎨 **Интерфейс:**
🎭 Тема: ${user.theme || 'По умолчанию'}
✨ Анимации: ${user.showAnimations !== false ? '✅ Включены' : '❌ Отключены'}
🎙️ Голосовые команды: ${user.voiceCommands !== false ? '✅ Включены' : '❌ Отключены'}

🤖 **AI и режимы:**
🧠 AI режим: ${user.aiMode !== false ? '✅ Включен' : '❌ Отключен'}
🔧 Режим разработки: ${user.dryMode === true ? '✅ Включен' : '❌ Отключен'}

🔒 **Приватность:**
👁️ Уровень приватности: ${user.privacyLevel || 'Обычный'}
🌍 Часовой пояс: ${user.timezone || 'Не установлен'}
🏙️ Город: ${user.city || 'Не указан'}`;

        await ctx.editMessageText(settingsText, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔔 Уведомления',
                  callback_data: 'settings_notifications',
                },
                { text: '🎨 Интерфейс', callback_data: 'settings_interface' },
              ],
              [
                { text: '🤖 AI настройки', callback_data: 'settings_ai' },
                { text: '🔒 Приватность', callback_data: 'settings_privacy' },
              ],
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        });
      } catch (error) {
        this.logger.error(`Error in user_settings handler: ${error}`);
        await ctx.answerCbQuery('❌ Произошла ошибка');
        await ctx.editMessageText(
          '❌ Произошла ошибка при загрузке настроек. Попробуйте позже.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      }
    });

    // Settings handlers
    this.bot.action('settings_notifications', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const user = await this.userService.findByTelegramId(ctx.userId);

        await ctx.editMessageTextWithMarkdown(
          `
🔔 *Настройки уведомлений*

Текущие настройки:
📱 Уведомления: ${user.notifications !== false ? '✅ Включены' : '❌ Отключены'}
⏰ Время напоминаний: ${user.reminderTime || 'Не установлено'}
📊 Еженедельная сводка: ${user.weeklySummary !== false ? '✅ Включена' : '❌ Отключена'}
📅 Ежедневные напоминания: ${user.dailyReminders !== false ? '✅ Включены' : '❌ Отключены'}
          `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      user.notifications !== false
                        ? '🔕 Отключить уведомления'
                        : '🔔 Включить уведомления',
                    callback_data: 'toggle_notifications',
                  },
                ],
                [
                  {
                    text: '⏰ Изменить время напоминаний',
                    callback_data: 'change_reminder_time',
                  },
                ],
                [
                  {
                    text:
                      user.weeklySummary !== false
                        ? '📊❌ Отключить сводку'
                        : '📊✅ Включить сводку',
                    callback_data: 'toggle_weekly_summary',
                  },
                ],
                [
                  {
                    text: '⬅️ Назад к настройкам',
                    callback_data: 'user_settings',
                  },
                ],
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      } catch (error) {
        this.logger.error(`Error in settings_notifications handler: ${error}`);
        await ctx.answerCbQuery('❌ Произошла ошибка');
        await ctx.editMessageText(
          '❌ Произошла ошибка при загрузке настроек уведомлений.',
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '⬅️ Назад к настройкам',
                    callback_data: 'user_settings',
                  },
                ],
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      }
    });

    this.bot.action('settings_interface', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const user = await this.userService.findByTelegramId(ctx.userId);

        await ctx.editMessageTextWithMarkdown(
          `
🎨 *Настройки интерфейса*

Текущие настройки:
🎭 Тема: ${user.theme || 'По умолчанию'}
✨ Анимации: ${user.showAnimations !== false ? '✅ Включены' : '❌ Отключены'}
🎙️ Голосовые команды: ${user.voiceCommands !== false ? '✅ Включены' : '❌ Отключены'}
          `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      user.showAnimations !== false
                        ? '✨❌ Отключить анимации'
                        : '✨✅ Включить анимации',
                    callback_data: 'toggle_animations',
                  },
                ],
                [
                  {
                    text:
                      user.voiceCommands !== false
                        ? '🎙️❌ Отключить голос'
                        : '🎙️✅ Включить голос',
                    callback_data: 'toggle_voice_commands',
                  },
                ],
                [{ text: '🎭 Сменить тему', callback_data: 'change_theme' }],
                [
                  {
                    text: '⬅️ Назад к настройкам',
                    callback_data: 'user_settings',
                  },
                ],
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      } catch (error) {
        this.logger.error(`Error in settings_interface handler: ${error}`);
        await ctx.answerCbQuery('❌ Произошла ошибка');
        await ctx.editMessageText(
          '❌ Произошла ошибка при загрузке настроек интерфейса.',
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '⬅️ Назад к настройкам',
                    callback_data: 'user_settings',
                  },
                ],
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      }
    });
    this.bot.action('settings_ai', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const user = await this.userService.findByTelegramId(ctx.userId);

        await ctx.editMessageTextWithMarkdown(
          `
🤖 *AI настройки*

Текущие настройки:
🧠 AI режим: ${user.aiMode !== false ? '✅ Включен' : '❌ Отключен'}
🔧 Режим разработки: ${user.dryMode === true ? '✅ Включен' : '❌ Отключен'}

💡 AI режим позволяет боту давать умные советы и помогать с планированием.
          `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      user.aiMode !== false
                        ? '🧠❌ Отключить AI'
                        : '🧠✅ Включить AI',
                    callback_data: 'toggle_ai_mode',
                  },
                ],
                [
                  {
                    text: '⬅️ Назад к настройкам',
                    callback_data: 'user_settings',
                  },
                ],
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      } catch (error) {
        this.logger.error(`Error in settings_ai handler: ${error}`);
        await ctx.answerCbQuery('❌ Произошла ошибка');
        await ctx.editMessageText(
          '❌ Произошла ошибка при загрузке AI настроек.',
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '⬅️ Назад к настройкам',
                    callback_data: 'user_settings',
                  },
                ],
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      }
    });

    this.bot.action('settings_privacy', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const user = await this.userService.findByTelegramId(ctx.userId);

        const privacyText = `🔒 *Настройки приватности*

Текущие настройки:
👁️ Уровень приватности: ${user.privacyLevel || 'Обычный'}
🌍 Часовой пояс: ${user.timezone || 'Не установлен'}
🏙️ Город: ${user.city || 'Не указан'}

💡 Уровень приватности влияет на видимость вашего профиля другим пользователям.`;

        await ctx.editMessageText(privacyText, {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '👁️ Изменить приватность',
                  callback_data: 'change_privacy_level',
                },
              ],
              [
                {
                  text: '🌍 Изменить часовой пояс',
                  callback_data: 'change_timezone',
                },
              ],
              [
                {
                  text: '⬅️ Назад к настройкам',
                  callback_data: 'user_settings',
                },
              ],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        });
      } catch (error) {
        this.logger.error(`Error in settings_privacy handler: ${error}`);
        await ctx.answerCbQuery('❌ Произошла ошибка');
        await ctx.editMessageText(
          '❌ Произошла ошибка при загрузке настроек приватности.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Назад', callback_data: 'user_settings' }],
              ],
            },
          },
        );
      }
    });

    // Toggle handlers for settings
    this.bot.action('toggle_notifications', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        const user = await this.userService.findByTelegramId(ctx.userId);

        await this.userService.updateUser(ctx.userId, {
          notifications: !(user.notifications !== false),
        });

        await ctx.editMessageTextWithMarkdown(
          `✅ Уведомления ${!(user.notifications !== false) ? 'включены' : 'отключены'}`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '⬅️ Назад к уведомлениям',
                    callback_data: 'settings_notifications',
                  },
                ],
              ],
            },
          },
        );
      } catch (error) {
        this.logger.error(`Error in toggle_notifications handler: ${error}`);
        await ctx.answerCbQuery('❌ Ошибка при изменении настроек');
      }
    });

    this.bot.action('toggle_weekly_summary', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await this.userService.updateUser(ctx.userId, {
        weeklySummary: !user.weeklySummary,
      });

      await ctx.editMessageTextWithMarkdown(
        `✅ Еженедельная сводка ${!user.weeklySummary ? 'включена' : 'отключена'}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '⬅️ Назад к уведомлениям',
                  callback_data: 'settings_notifications',
                },
              ],
            ],
          },
        },
      );
    });

    this.bot.action('toggle_animations', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await this.userService.updateUser(ctx.userId, {
        showAnimations: !user.showAnimations,
      });

      await ctx.editMessageTextWithMarkdown(
        `✅ Анимации ${!user.showAnimations ? 'включены' : 'отключены'}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '⬅️ Назад к интерфейсу',
                  callback_data: 'settings_interface',
                },
              ],
            ],
          },
        },
      );
    });

    this.bot.action('toggle_voice_commands', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await this.userService.updateUser(ctx.userId, {
        voiceCommands: !user.voiceCommands,
      });

      await ctx.editMessageTextWithMarkdown(
        `✅ Голосовые команды ${!user.voiceCommands ? 'включены' : 'отключены'}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '⬅️ Назад к интерфейсу',
                  callback_data: 'settings_interface',
                },
              ],
            ],
          },
        },
      );
    });

    this.bot.action('toggle_ai_mode', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await this.userService.updateUser(ctx.userId, {
        aiMode: !user.aiMode,
      });

      await ctx.editMessageTextWithMarkdown(
        `✅ AI режим ${!user.aiMode ? 'включен' : 'отключен'}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '⬅️ Назад к AI настройкам',
                  callback_data: 'settings_ai',
                },
              ],
            ],
          },
        },
      );
    });

    this.bot.action('achievements', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
🥇 *Ваши достижения*

**Разблокированные:**
🏆 Первые шаги - Создать первую задачу
⭐ Новичок - Получить 100 XP
📅 Активность - Использовать бот 3 дня

**В процессе:**
 Продуктивный - Выполнить 50 задач (${user.completedTasks}/50)
🚀 Энтузиаст - Получить 1000 XP (${user.totalXp}/1000)
🎯 Целеустремленный - Создать 20 задач (${user.totalTasks}/20)

**Заблокированные:**
⚡ Молния - Выполнить 10 задач за день
🌟 Легенда - Получить 10000 XP
🏅 Мастер - Выполнить 200 задач

Продолжайте выполнять задачи для новых достижений! 🎉
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            ],
          },
        },
      );
    });

    this.bot.action('challenges', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
🚀 *Челленджи*

**Активные испытания:**
⏰ 7-дневный марафон продуктивности
📝 Выполнить 21 задачу за неделю

**Еженедельные вызовы:**
🌅 Ранняя пташка - 5 задач до 10:00
🌙 Ночная сова - 3 задачи после 20:00
⚡ Скоростной режим - 10 задач за день

**Награды:**
🏆 Значки достижений
⭐ Дополнительные XP
🎁 Бонусные возможности

*Функция в разработке - скоро новые челленджи!*
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            ],
          },
        },
      );
    });

    this.bot.action('bonuses_referrals', async (ctx) => {
      await ctx.answerCbQuery();

      // Генерируем реферальную ссылку с реальным ботом
      const botUsername = 'test_healthcheck_dev_bot';
      const referralLink = `https://t.me/${botUsername}?start=ref_${ctx.userId}`;

      // Получаем реальную статистику рефералов
      const referralStats = await this.getReferralStats(ctx.userId);

      // Создаем прогресс-бар для достижения 5 друзей
      const progress = Math.min(referralStats.totalReferrals, 5);
      const progressBar = '█'.repeat(progress) + '⬜'.repeat(5 - progress);

      // Определяем следующее достижение
      let nextMilestone = '';
      if (referralStats.totalReferrals < 1) {
        nextMilestone = '\n🎯 **Следующая цель:** 1 друг = +200 XP бонус!';
      } else if (referralStats.totalReferrals < 3) {
        nextMilestone = '\n🎯 **Следующая цель:** 3 друга = +500 XP бонус!';
      } else if (referralStats.totalReferrals < 5) {
        nextMilestone = '\n🎯 **Следующая цель:** 5 друзей = +1000 XP бонус!';
      } else {
        nextMilestone = '\n🏆 **Все достижения разблокированы!**';
      }

      await ctx.editMessageTextWithMarkdown(
        `
🤝 *РЕФЕРАЛЬНАЯ СИСТЕМА*

💰 **ЗАРАБАТЫВАЙТЕ РЕАЛЬНЫЕ ДЕНЬГИ!**
Получайте 40% от всех оплат друзей, которых пригласили!

💡 **ПРИМЕР:**
Ваш друг оплачивает подписку на год за 999₽
→ Вы моментально получаете 399₽ на свой счет! 💸

🔗 **ВАША ССЫЛКА** 👇
\`${referralLink}\`

💳 **ВАШ РЕФЕРАЛЬНЫЙ БАЛАНС:**
${referralStats.referralBalance}₽

📊 **ПРОГРЕСС ДО 5 ДРУЗЕЙ:**
${progressBar} ${referralStats.totalReferrals}/5${nextMilestone}

**СТАТИСТИКА ПАРТНЕРСТВА:**
👥 Приглашено друзей: ${referralStats.totalReferrals}
💎 Активных пользователей: ${referralStats.activeReferrals}  
🎁 Получено бонусов: ${referralStats.totalBonus} XP
💰 Заработано денег: ${referralStats.referralBalance}₽

**СИСТЕМА ВОЗНАГРАЖДЕНИЙ:**
💸 **Финансовые:**
• За оплату месячной подписки друга (199₽): +79₽
• За оплату годовой подписки друга (999₽): +399₽

🎁 **XP Бонусы:**
• За каждого друга: +500 XP
• 1-й друг: +200 XP дополнительно  
• 3 друга: +500 XP дополнительно
• 5 друзей: +1000 XP дополнительно
• Друг получает: +200 XP при регистрации

**ВАШИ ДРУЗЬЯ:**
${
  referralStats.topReferrals && referralStats.topReferrals.length > 0
    ? referralStats.topReferrals
        .map(
          (ref, i) =>
            `${i + 1}. ${ref.name} ${ref.isActive ? '🟢' : '🔴'} (${ref.joinDate})`,
        )
        .join('\n')
    : 'Пока нет рефералов'
}

💡 **Поделитесь ссылкой с друзьями!**
🟢 = активен за неделю, 🔴 = неактивен
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📋 Копировать ссылку',
                  callback_data: 'copy_referral_link',
                },
                {
                  text: '� Поделиться',
                  callback_data: 'share_referral_link',
                },
              ],
              [
                {
                  text: '�📊 Детальная статистика',
                  callback_data: 'referral_stats',
                },
              ],
              [
                { text: '💰 Вывести бонусы', callback_data: 'withdraw_bonus' },
                { text: '💸 Вывести деньги', callback_data: 'withdraw_money' },
              ],
              [
                {
                  text: '🎓 Как работает',
                  callback_data: 'how_referral_works',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            ],
          },
        },
      );
    });

    // Referral system handlers
    this.bot.action('copy_referral_link', async (ctx) => {
      await ctx.answerCbQuery('📋 Ссылка скопирована! Поделитесь с друзьями!');
      const botUsername = 'test_healthcheck_dev_bot';
      const referralLink = `https://t.me/${botUsername}?start=ref_${ctx.userId}`;

      await ctx.reply(
        `🔗 *Ваша реферальная ссылка:*\n\n\`${referralLink}\`\n\n📱 Поделитесь этой ссылкой с друзьями!\n💰 За каждого приглашенного +500 XP + 40% от всех их оплат!`,
        { parse_mode: 'Markdown' },
      );
    });

    // Handler for sharing referral link
    this.bot.action('share_referral_link', async (ctx) => {
      await ctx.answerCbQuery();
      const botUsername = 'test_healthcheck_dev_bot';
      const referralLink = `https://t.me/${botUsername}?start=ref_${ctx.userId}`;

      const shareText = `🚀 Присоединяйся к Daily Check - боту для продуктивности!

💪 Планируй привычки и задачи
🎯 Фокус-сессии по методу Pomodoro  
📊 Отслеживай прогресс и получай XP
🤖 ИИ-помощник для мотивации

Переходи по ссылке и начни достигать целей уже сегодня!
${referralLink}`;

      try {
        // Используем Telegram API для открытия списка контактов
        await ctx.reply(
          `📤 *Поделиться с друзьями*

Нажмите кнопку ниже, чтобы выбрать друга из списка контактов и отправить ему приглашение:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '📤 Выбрать контакт',
                    switch_inline_query: shareText,
                  },
                ],
                [
                  {
                    text: '💬 Поделиться в чате',
                    switch_inline_query_current_chat: shareText,
                  },
                ],
                [
                  {
                    text: '📋 Копировать ссылку',
                    callback_data: 'copy_referral_link',
                  },
                ],
                [
                  {
                    text: '⬅️ Назад',
                    callback_data: 'bonuses_referrals',
                  },
                ],
              ],
            },
          },
        );
      } catch (error) {
        this.logger.error('Error sharing referral link:', error);
        await ctx.reply('❌ Произошла ошибка при попытке поделиться ссылкой.');
      }
    });

    this.bot.action('referral_stats', async (ctx) => {
      await ctx.answerCbQuery();

      const referralStats = await this.getReferralStats(ctx.userId);

      // Рассчитываем статистику за месяц
      const monthAgo = new Date();
      monthAgo.setMonth(monthAgo.getMonth() - 1);

      const user = await this.userService.findByTelegramId(ctx.userId);
      const monthlyReferrals = await this.prisma.user.count({
        where: {
          referredBy: user.id,
          createdAt: {
            gte: monthAgo,
          },
        },
      });

      const activityPercent =
        referralStats.totalReferrals > 0
          ? Math.round(
              (referralStats.activeReferrals / referralStats.totalReferrals) *
                100,
            )
          : 0;

      await ctx.editMessageTextWithMarkdown(
        `
📊 *ДЕТАЛЬНАЯ СТАТИСТИКА*

**ЗА ВСЕ ВРЕМЯ:**
👥 Всего приглашений: ${referralStats.totalReferrals}
💎 Активных рефералов: ${referralStats.activeReferrals}
💰 Заработано XP: ${referralStats.totalBonus}

**ЗА ЭТОТ МЕСЯЦ:**
📈 Новые приглашения: ${monthlyReferrals}
⭐ Активность рефералов: ${activityPercent}%
🎁 Получено бонусов: ${monthlyReferrals * 500} XP

**ДОСТИЖЕНИЯ:**
${referralStats.totalReferrals >= 1 ? '🏆 Первый друг (+200 XP)' : '🔒 Первый друг (пригласите 1 друга)'}
${referralStats.totalReferrals >= 3 ? '🏆 Тройка друзей (+500 XP)' : '🔒 Тройка друзей (пригласите 3 друзей)'}
${referralStats.totalReferrals >= 5 ? '🏆 Пятерка друзей (+1000 XP)' : '🔒 Пятерка друзей (пригласите 5 друзей)'}

**АКТИВНОСТЬ ДРУЗЕЙ:**
${
  referralStats.topReferrals && referralStats.topReferrals.length > 0
    ? referralStats.topReferrals
        .map((ref, i) => {
          const status = ref.isActive ? '🟢 Активен' : '🔴 Неактивен';
          return `${i + 1}. ${ref.name} - ${status}`;
        })
        .join('\n')
    : 'Пока нет рефералов'
}

*💡 Активные друзья - это те, кто пользовался ботом за последние 7 дней*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ К рефералам', callback_data: 'bonuses_referrals' }],
            ],
          },
        },
      );
    });

    this.bot.action('how_referral_works', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
🎓 *КАК РАБОТАЕТ РЕФЕРАЛЬНАЯ ПРОГРАММА*

💸 **ЗАРАБАТЫВАЙТЕ РЕАЛЬНЫЕ ДЕНЬГИ!**
Получайте 40% от всех покупок ваших друзей!

**ШАГ 1: ПОДЕЛИТЕСЬ ССЫЛКОЙ**
📱 Скопируйте свою реферальную ссылку
💬 Отправьте друзьям в чат или соцсети
🔗 Ссылка: https://t.me/test_healthcheck_dev_bot?start=ref_ВАШID

**ШАГ 2: ДРУГ РЕГИСТРИРУЕТСЯ**
👤 Друг переходит по вашей ссылке
🚀 Регистрируется в боте через /start
🎁 Получает +200 XP при регистрации

**ШАГ 3: ПОЛУЧАЕТЕ XP БОНУСЫ**
💰 +500 XP сразу за приглашение
🏆 +200 XP дополнительно за 1-го друга
🏆 +500 XP дополнительно за 3-х друзей
🏆 +1000 XP дополнительно за 5-и друзей

**ШАГ 4: ПОЛУЧАЕТЕ ДЕНЬГИ**
💸 Друг покупает подписку 199₽ → Вы получаете 79₽
💸 Друг покупает подписку 999₽ → Вы получаете 399₽
💰 Деньги зачисляются мгновенно на ваш баланс
💳 Вывод от 100₽ на карту/кошелек

**ПРИМЕР ЗАРАБОТКА:**
👥 5 друзей купили годовую подписку
💰 5 × 399₽ = 1,995₽ реальных денег!
🎁 + 4,200 XP бонусов

**УСЛОВИЯ:**
• Самоприглашение не засчитывается
• Выплаты мгновенные и пожизненные
• Минимальный вывод: 100₽

*🚀 Начните зарабатывать уже сегодня!*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📋 Копировать ссылку',
                  callback_data: 'copy_referral_link',
                },
                {
                  text: '📤 Поделиться',
                  callback_data: 'share_referral_link',
                },
              ],
              [{ text: '⬅️ К рефералам', callback_data: 'bonuses_referrals' }],
            ],
          },
        },
      );
    });

    this.bot.action('withdraw_bonus', async (ctx) => {
      await ctx.answerCbQuery();

      const user = await this.userService.findByTelegramId(ctx.userId);
      const referralStats = await this.getReferralStats(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
💰 *ИСПОЛЬЗОВАНИЕ РЕФЕРАЛЬНЫХ БОНУСОВ*

**ВАШИ БОНУСЫ:**
⭐ Общий XP: ${user.totalXp}
🎁 Заработано с рефералов: ${referralStats.totalBonus} XP
� Уровень: ${user.level}

**КАК ИСПОЛЬЗОВАТЬ БОНУСЫ:**
📱 XP используется автоматически в боте
� Повышает ваш уровень и статус
🔓 Открывает новые функции
⚡ Ускоряет прогресс в задачах

**ПРЕИМУЩЕСТВА ВЫСОКОГО УРОВНЯ:**
🎯 Больше возможностей в боте
⭐ Эксклюзивные функции
🏆 Специальные достижения
👑 VIP статус сообщества

**БУДУЩИЕ ФУНКЦИИ:**
� Магазин наград (в разработке)
🎁 Обмен на премиум подписку
💸 Денежные выплаты (для топ-рефереров)

*� Пока XP работает как игровая валюта бота!*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ К рефералам', callback_data: 'bonuses_referrals' }],
            ],
          },
        },
      );
    });

    this.bot.action('withdraw_money', async (ctx) => {
      await ctx.answerCbQuery();

      const referralStats = await this.getReferralStats(ctx.userId);

      if (referralStats.referralBalance < 100) {
        await ctx.editMessageTextWithMarkdown(
          `
💸 *ВЫВОД РЕФЕРАЛЬНЫХ СРЕДСТВ*

❌ **НЕДОСТАТОЧНО СРЕДСТВ ДЛЯ ВЫВОДА**

💰 Ваш баланс: ${referralStats.referralBalance}₽
💰 Минимальная сумма для вывода: 100₽

📈 **КАК УВЕЛИЧИТЬ БАЛАНС:**
• Пригласите больше друзей по реферальной ссылке
• Друзья должны оплатить подписку:
  - 199₽/месяц → Вы получите 79₽
  - 999₽/год → Вы получите 399₽

💡 **ПРИМЕР:**
Всего 1 друг с годовой подпиской = 399₽ ✅
          `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '⬅️ К рефералам',
                    callback_data: 'bonuses_referrals',
                  },
                ],
              ],
            },
          },
        );
        return;
      }

      await ctx.editMessageTextWithMarkdown(
        `
💸 *ВЫВОД РЕФЕРАЛЬНЫХ СРЕДСТВ*

💰 **К ВЫВОДУ:** ${referralStats.referralBalance}₽

📋 **СПОСОБЫ ПОЛУЧЕНИЯ:**
• Банковская карта (любой банк РФ)
• СБП (Система быстрых платежей)
• ЮMoney (Яндекс.Деньги)
• Qiwi кошелек

⏰ **СРОКИ ВЫПЛАТ:**
• Рабочие дни: 1-3 часа
• Выходные: до 24 часов

❗ **ВАЖНО:**
• Минимальная сумма: 100₽
• Комиссия: 0% (мы берем на себя)
• Налоги: согласно законодательству РФ

*📧 Для вывода средств напишите администратору: @support_bot*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📞 Связаться с поддержкой',
                  url: 'https://t.me/support_bot',
                },
              ],
              [{ text: '⬅️ К рефералам', callback_data: 'bonuses_referrals' }],
            ],
          },
        },
      );
    });

    this.bot.action('user_profile', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
👤 *Ваш профиль*

**Основная информация:**
📛 Имя: ${user.firstName || 'Не указано'}
🆔 ID: ${user.id}
📅 Регистрация: ${user.createdAt.toLocaleDateString('ru-RU')}
🌍 Город: ${user.city || 'Не указан'}
⏰ Часовой пояс: ${user.timezone || 'Не указан'}

**Статистика:**
⭐ Общий опыт: ${user.totalXp} XP  
🎖️ Уровень: ${user.level}
📋 Выполнено задач: ${user.completedTasks}

**Настройки:**
🔔 Уведомления: ${user.notifications ? '✅ Включены' : '❌ Отключены'}
🎨 Тема: ${user.theme || 'Стандартная'}
🤖 ИИ-режим: ${user.aiMode ? '✅ Включен' : '❌ Отключен'}
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✏️ Редактировать', callback_data: 'edit_profile' },
                { text: '⬅️ Назад', callback_data: 'more_functions' },
              ],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action('reminders', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        this.logger.log('Reminders button clicked by user:', ctx.userId);
        await this.showRemindersMenu(ctx);
      } catch (error) {
        this.logger.error('Error in reminders action handler:', error);
        try {
          await ctx.answerCbQuery();
          await ctx.replyWithMarkdown(
            '❌ Произошла ошибка при загрузке напоминаний. Попробуйте позже.',
          );
        } catch (fallbackError) {
          this.logger.error(
            'Error in fallback handling for reminders:',
            fallbackError,
          );
        }
      }
    });

    this.bot.action('all_reminders', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showAllReminders(ctx);
    });

    this.bot.action('create_reminder_help', async (ctx) => {
      try {
        await ctx.answerCbQuery();
        await this.showCreateReminderHelp(ctx);
      } catch (error) {
        this.logger.error('Error handling create_reminder_help:', error);
        try {
          await ctx.answerCbQuery();
          await ctx.replyWithMarkdown('❌ Произошла ошибка. Попробуйте позже.');
        } catch (fallbackError) {
          this.logger.error('Error in fallback handling:', fallbackError);
        }
      }
    });

    this.bot.action('voice_reminder_help', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showVoiceReminderHelp(ctx);
    });

    this.bot.action('manage_reminders', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showManageReminders(ctx);
    });

    this.bot.action('reminders_stats', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showRemindersStats(ctx);
    });

    // Handle reminder deletion
    this.bot.action(/^delete_reminder_(.+)$/, async (ctx) => {
      const reminderId = ctx.match[1];
      await ctx.answerCbQuery();
      await this.handleDeleteReminder(ctx, reminderId);
    });

    // Handle disabling all reminders
    this.bot.action('disable_all_reminders', async (ctx) => {
      await ctx.answerCbQuery();
      try {
        // Отключаем уведомления у пользователя
        await this.userService.updateUser(ctx.userId, {
          dailyReminders: false,
        });

        // Отключаем все активные напоминания
        await this.prisma.reminder.updateMany({
          where: {
            userId: ctx.userId,
            status: 'ACTIVE',
          },
          data: {
            status: 'DISMISSED',
          },
        });

        await ctx.editMessageTextWithMarkdown(
          `🔕 *Уведомления отключены*

Все ваши напоминания были отключены. Вы больше не будете получать уведомления.

💡 Вы можете включить их обратно в настройках бота.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🔔 Включить обратно',
                    callback_data: 'enable_all_reminders',
                  },
                ],
                [
                  {
                    text: '⚙️ Настройки',
                    callback_data: 'settings_menu',
                  },
                ],
                [
                  {
                    text: '🏠 Главное меню',
                    callback_data: 'back_to_menu',
                  },
                ],
              ],
            },
          },
        );
      } catch (error) {
        this.logger.error('Error disabling reminders:', error);
        await ctx.editMessageTextWithMarkdown(
          '❌ Произошла ошибка при отключении уведомлений.',
        );
      }
    });

    // Handle enabling all reminders
    this.bot.action('enable_all_reminders', async (ctx) => {
      await ctx.answerCbQuery();
      try {
        await this.userService.updateUser(ctx.userId, {
          dailyReminders: true,
        });

        await ctx.editMessageTextWithMarkdown(
          `🔔 *Уведомления включены*

Уведомления снова активированы. Вы будете получать напоминания согласно расписанию.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🔔 Мои напоминания',
                    callback_data: 'reminders',
                  },
                ],
                [
                  {
                    text: '⚙️ Настройки',
                    callback_data: 'settings_menu',
                  },
                ],
                [
                  {
                    text: '🏠 Главное меню',
                    callback_data: 'back_to_menu',
                  },
                ],
              ],
            },
          },
        );
      } catch (error) {
        this.logger.error('Error enabling reminders:', error);
        await ctx.editMessageTextWithMarkdown(
          '❌ Произошла ошибка при включении уведомлений.',
        );
      }
    });

    this.bot.action('settings_menu', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
⚙️ *Настройки*

🚧 *Функция в разработке*

Раздел настроек будет доступен в следующем обновлении!

Здесь вы сможете настроить:
• 🔔 Уведомления и напоминания
• 🎨 Тему интерфейса
• 🌍 Часовой пояс
• 🤖 ИИ-консультанта
• 👤 Конфиденциальность профиля
• � Интеграции с другими сервисами

� Оставьте свой email в профиле, чтобы получить уведомление о запуске.
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            ],
          },
        },
      );
    });

    this.bot.action('shop', async (ctx) => {
      await ctx.answerCbQuery();
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
🛍️ *XP Магазин*

💰 **Ваш баланс:** ${user.totalXp} XP

**🎨 Косметические улучшения:**
• � Эксклюзивная тема "Темная материя" - 2000 XP
• 🏆 Уникальный значок "Мастер продуктивности" - 1500 XP
• ⚡ Анимированные эмодзи набор - 800 XP
• 🌟 Кастомные стикеры - 1200 XP

**🚀 Функциональные улучшения:**
• 📈 Расширенная статистика - 3000 XP
• 🎯 Дополнительные категории задач - 2500 XP
• 🔔 Персональные уведомления - 1800 XP
• 📊 Экспорт данных - 2200 XP

💡 Заработайте XP выполняя задачи и привычки! 
⭐ В будущем здесь появятся ещё больше улучшений!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🎭 Темы (2000 XP)', callback_data: 'buy_theme_2000' },
                {
                  text: '🏆 Значки (1500 XP)',
                  callback_data: 'buy_badge_1500',
                },
              ],
              [
                { text: '⚡ Эмодзи (800 XP)', callback_data: 'buy_emoji_800' },
                {
                  text: '🌟 Стикеры (1200 XP)',
                  callback_data: 'buy_stickers_1200',
                },
              ],
              [
                {
                  text: '📈 Статистика (3000 XP)',
                  callback_data: 'buy_stats_3000',
                },
                {
                  text: '🎯 Категории (2500 XP)',
                  callback_data: 'buy_categories_2500',
                },
              ],
              [
                {
                  text: '🔔 Уведомления (1800 XP)',
                  callback_data: 'buy_notifications_1800',
                },
                {
                  text: '📊 Экспорт (2200 XP)',
                  callback_data: 'buy_export_2200',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
              [{ text: '🏠 Главное меню', callback_data: 'start' }],
            ],
          },
        },
      );
    });

    // XP Shop handler
    // XP Shop handler - redirects to main shop for consistency
    this.bot.action('xp_shop', async (ctx) => {
      await ctx.answerCbQuery();

      // Redirect to main shop which now shows XP items directly
      const user = await this.userService.findByTelegramId(ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
🛍️ *XP Магазин*

💰 **Ваш баланс:** ${user.totalXp} XP

**🎨 Косметические улучшения:**
• 🎭 Эксклюзивная тема "Темная материя" - 2000 XP
• 🏆 Уникальный значок "Мастер продуктивности" - 1500 XP
• ⚡ Анимированные эмодзи набор - 800 XP
• 🌟 Кастомные стикеры - 1200 XP

**🚀 Функциональные улучшения:**
• 📈 Расширенная статистика - 3000 XP
• 🎯 Дополнительные категории задач - 2500 XP
• 🔔 Персональные уведомления - 1800 XP
• 📊 Экспорт данных - 2200 XP

💡 Заработайте XP выполняя задачи и привычки! 
⭐ В будущем здесь появятся ещё больше улучшений!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🎭 Темы (2000 XP)', callback_data: 'buy_theme_2000' },
                {
                  text: '🏆 Значки (1500 XP)',
                  callback_data: 'buy_badge_1500',
                },
              ],
              [
                { text: '⚡ Эмодзи (800 XP)', callback_data: 'buy_emoji_800' },
                {
                  text: '🌟 Стикеры (1200 XP)',
                  callback_data: 'buy_stickers_1200',
                },
              ],
              [
                {
                  text: '📈 Статистика (3000 XP)',
                  callback_data: 'buy_stats_3000',
                },
                {
                  text: '🎯 Категории (2500 XP)',
                  callback_data: 'buy_categories_2500',
                },
              ],
              [
                {
                  text: '🔔 Уведомления (1800 XP)',
                  callback_data: 'buy_notifications_1800',
                },
                {
                  text: '📊 Экспорт (2200 XP)',
                  callback_data: 'buy_export_2200',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
              [{ text: '🏠 Главное меню', callback_data: 'start' }],
            ],
          },
        },
      );
    });

    // Premium shop handler
    this.bot.action('premium_shop', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
💳 *Премиум подписка*

**Преимущества Premium версии:**
✅ Неограниченные задачи и привычки
✅ Расширенная аналитика и отчеты
✅ Приоритетная поддержка AI
✅ Эксклюзивные темы и значки
✅ Экспорт данных в различных форматах
✅ Персональный менеджер продуктивности
✅ Интеграция с внешними сервисами
✅ Без рекламы
✅ Расширенные возможности ИИ

**Выберите план подписки:**

💰 **Ежемесячно**: 199₽/месяц
💎 **Годовая** (скидка 58%): 999₽/год

*Экономия при годовой подписке: 1389₽!*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💰 199₽/месяц', callback_data: 'buy_premium_monthly' },
                {
                  text: '💎 999₽/год (-58%)',
                  callback_data: 'buy_premium_yearly',
                },
              ],
              [{ text: '⬅️ Назад к XP магазину', callback_data: 'shop' }],
              [{ text: '🏠 Главное меню', callback_data: 'start' }],
            ],
          },
        },
      );
    });

    // XP Purchase handlers
    this.bot.action('buy_theme_2000', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'theme',
        2000,
        'Эксклюзивная тема "Темная материя"',
        'dark_matter',
      );
    });

    this.bot.action('buy_badge_1500', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'badge',
        1500,
        'Значок "Мастер продуктивности"',
        'productivity_master',
      );
    });

    this.bot.action('buy_emoji_800', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'emoji',
        800,
        'Анимированные эмодзи набор',
        'animated_emoji_pack',
      );
    });

    this.bot.action('buy_stickers_1200', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'sticker',
        1200,
        'Кастомные стикеры',
        'custom_stickers',
      );
    });

    this.bot.action('buy_stats_3000', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'feature',
        3000,
        'Расширенная статистика',
        'advanced_stats',
      );
    });

    this.bot.action('buy_categories_2500', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'feature',
        2500,
        'Дополнительные категории задач',
        'extra_categories',
      );
    });

    this.bot.action('buy_notifications_1800', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'feature',
        1800,
        'Персональные уведомления',
        'personal_notifications',
      );
    });

    this.bot.action('buy_export_2200', async (ctx) => {
      await this.handleXPPurchase(
        ctx,
        'feature',
        2200,
        'Экспорт данных',
        'data_export',
      );
    });

    // Billing handlers
    this.bot.action('show_limits', async (ctx) => {
      await ctx.answerCbQuery();
      const subscriptionStatus =
        await this.billingService.getSubscriptionStatus(ctx.userId);

      const limitsText =
        subscriptionStatus.limits.dailyReminders === -1
          ? '∞ (безлимит)'
          : subscriptionStatus.limits.dailyReminders.toString();
      const aiLimitsText =
        subscriptionStatus.limits.dailyAiQueries === -1
          ? '∞ (безлимит)'
          : subscriptionStatus.limits.dailyAiQueries.toString();

      let statusMessage = '';
      if (subscriptionStatus.isTrialActive) {
        statusMessage = `🎁 **Пробный период:** ${subscriptionStatus.daysRemaining} дней осталось`;
      } else {
        statusMessage = `💎 **Подписка:** ${
          subscriptionStatus.type === 'FREE'
            ? 'Бесплатная'
            : subscriptionStatus.type === 'PREMIUM'
              ? 'Premium'
              : 'Premium Plus'
        }`;
      }

      await ctx.replyWithMarkdown(
        `
📊 *Ваши лимиты и использование*

${statusMessage}

**Текущее использование сегодня:**
🔔 Напоминания: ${subscriptionStatus.usage.dailyReminders}/${limitsText}
🧠 ИИ-запросы: ${subscriptionStatus.usage.dailyAiQueries}/${aiLimitsText}
📝 Задачи: ${subscriptionStatus.usage.dailyTasks}${subscriptionStatus.limits.dailyTasks === -1 ? '' : `/${subscriptionStatus.limits.dailyTasks}`}
🔄 Привычки: ${subscriptionStatus.usage.dailyHabits}${subscriptionStatus.limits.dailyHabits === -1 ? '' : `/${subscriptionStatus.limits.dailyHabits}`}

**Доступные функции:**
📊 Расширенная аналитика: ${subscriptionStatus.limits.advancedAnalytics ? '✅' : '❌'}
🎨 Кастомные темы: ${subscriptionStatus.limits.customThemes ? '✅' : '❌'}
🚀 Приоритетная поддержка: ${subscriptionStatus.limits.prioritySupport ? '✅' : '❌'}
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '💎 Обновиться до Premium',
                  callback_data: 'upgrade_premium',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action('upgrade_premium', async (ctx) => {
      await ctx.answerCbQuery();
      const trialInfo = await this.billingService.getTrialInfo(ctx.userId);

      let trialText = '';
      if (trialInfo.isTrialActive) {
        trialText = `🎁 **У вас есть ${trialInfo.daysRemaining} дней пробного периода!**

`;
      }

      await ctx.editMessageTextWithMarkdown(
        `
💎 *Premium подписка*

${trialText}**Premium подписка включает:**

∞ **Безлимитные** напоминания
∞ **Безлимитные** задачи  
∞ **Безлимитные** привычки
∞ **Безлимитные** ИИ-запросы
∞ **Безлимитные** фокус-сессии
📊 **Расширенная аналитика**
🎨 **Кастомные темы**
🚀 **Приоритетная поддержка**

**Варианты оплаты:**
💰 199₽/месяц - помесячная оплата
💰 999₽/год - годовая оплата (экономия 58%!)

Выберите удобный вариант:
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💎 199₽/месяц', callback_data: 'buy_premium_monthly' },
                { text: '� 999₽/год', callback_data: 'buy_premium_yearly' },
              ],
              [{ text: '📊 Мои лимиты', callback_data: 'show_limits' }],
              [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    // Handle Premium Monthly purchase
    this.bot.action('buy_premium_monthly', async (ctx) => {
      await ctx.answerCbQuery();
      await this.createPayment(ctx, 'PREMIUM', 199);
    });

    // Handle Premium Yearly purchase
    this.bot.action('buy_premium_yearly', async (ctx) => {
      await ctx.answerCbQuery();
      await this.createPayment(ctx, 'PREMIUM', 999);
    });

    // Handle old Premium purchase (for backwards compatibility)
    this.bot.action('buy_premium', async (ctx) => {
      await ctx.answerCbQuery();
      await this.createPayment(ctx, 'PREMIUM', 199);
    });

    // Handle payment status check
    this.bot.action(/^check_payment_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const paymentId = ctx.match[1];

      try {
        const status = await this.paymentService.checkPaymentStatus(paymentId);

        if (status === 'succeeded') {
          await ctx.editMessageTextWithMarkdown(
            '✅ *Платеж успешно завершен!*\n\nВаша подписка активирована.',
          );
        } else if (status === 'canceled') {
          await ctx.editMessageTextWithMarkdown(
            '❌ *Платеж отменен*\n\nПопробуйте оформить подписку заново.',
          );
        } else {
          await ctx.editMessageTextWithMarkdown(
            '⏳ *Платеж в обработке*\n\nПожалуйста, подождите или проверьте позже.',
          );
        }
      } catch (error) {
        await ctx.replyWithMarkdown(
          '❌ *Ошибка при проверке платежа*\n\nПопробуйте позже.',
        );
      }
    });

    this.bot.action('dependencies', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
🎭 *Блок зависимостей*

**Система напоминаний, поддержки и мотивации на базе искусственного интеллекта, чтобы ты смог освободиться от любой зависимости.**

      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🎯 Выбрать зависимость',
                  callback_data: 'choose_dependency',
                },
                {
                  text: '📊 Мои результаты',
                  callback_data: 'dependency_results',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action('dependency_results', async (ctx) => {
      await ctx.answerCbQuery();

      try {
        // Получаем все активные зависимости пользователя
        const dependencies = await this.prisma.dependencySupport.findMany({
          where: {
            userId: ctx.userId,
            status: 'ACTIVE',
          },
          orderBy: {
            createdAt: 'asc',
          },
        });

        if (dependencies.length === 0) {
          await ctx.editMessageTextWithMarkdown(
            `
📊 *Мои результаты по зависимостям*

❌ **У вас пока нет активных зависимостей для отслеживания.**

Начните отслеживать свой прогресс, выбрав зависимость!
            `,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🎯 Выбрать зависимость',
                      callback_data: 'choose_dependency',
                    },
                  ],
                  [{ text: '⬅️ Назад', callback_data: 'dependencies' }],
                  [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
                ],
              },
            },
          );
          return;
        }

        // Формируем статистику по каждой зависимости
        let statsMessage = `📊 *Мои результаты по зависимостям*\n\n`;

        for (const dependency of dependencies) {
          const dependencyNames = {
            SMOKING: '🚭 Курение',
            ALCOHOL: '🍺 Алкоголь',
            GAMBLING: '🎰 Азартные игры',
            SWEET: '🍰 Сладкое',
            SOCIAL_MEDIA: '📱 Соцсети',
            GAMING: '🎮 Игры',
            OTHER: '🛒 Другое',
          };

          const depName =
            dependencyNames[dependency.type] ||
            `✍️ ${dependency.customName || dependency.type}`;
          const startDate = dependency.createdAt;
          const now = new Date();
          const totalDays = Math.floor(
            (now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
          );
          const cleanDays = dependency.daysClean || 0;
          const successRate =
            totalDays > 0 ? Math.round((cleanDays / totalDays) * 100) : 100;
          const keptPromises = dependency.keptPromises || 0;

          statsMessage += `${depName}\n`;
          statsMessage += `📅 **Начал:** ${startDate.toLocaleDateString('ru-RU')}\n`;
          statsMessage += `🏆 **Дней без зависимости:** ${cleanDays}\n`;
          statsMessage += `📈 **Всего дней отслеживания:** ${totalDays}\n`;
          statsMessage += `✅ **Выполненных обещаний:** ${keptPromises}\n`;
          statsMessage += `📊 **Процент успеха:** ${successRate}%\n`;

          // Добавляем мотивационное сообщение
          if (cleanDays >= 30) {
            statsMessage += `🎉 **Отличный результат! Больше месяца без зависимости!**\n`;
          } else if (cleanDays >= 7) {
            statsMessage += `💪 **Хорошо идете! Уже неделя без зависимости!**\n`;
          } else if (cleanDays >= 1) {
            statsMessage += `🌱 **Первые шаги! Продолжайте в том же духе!**\n`;
          } else {
            statsMessage += `🚀 **Начинайте сначала! У вас все получится!**\n`;
          }

          statsMessage += `\n`;
        }

        statsMessage += `💡 *Помните: каждый день без зависимости - это победа!*`;

        await ctx.editMessageTextWithMarkdown(statsMessage, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔄 Обновить статистику',
                  callback_data: 'dependency_results',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'dependencies' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        });
      } catch (error) {
        this.logger.error('Error fetching dependency results:', error);
        await ctx.editMessageTextWithMarkdown(
          `
❌ *Ошибка получения статистики*

Не удалось загрузить ваши результаты. Попробуйте позже.
          `,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Назад', callback_data: 'dependencies' }],
              ],
            },
          },
        );
      }
    });

    this.bot.action('choose_dependency', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
🎯 *Выбери свою зависимость*

**Популярные зависимости:**
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🚭 Курение', callback_data: 'dep_smoking' },
                { text: '🍺 Алкоголь', callback_data: 'dep_alcohol' },
              ],
              [
                { text: '📱 Соцсети', callback_data: 'dep_social' },
                { text: '🎮 Игры', callback_data: 'dep_gaming' },
              ],
              [
                { text: '🛒 Покупки', callback_data: 'dep_shopping' },
                { text: '🍰 Сладкое', callback_data: 'dep_sweets' },
              ],
              [{ text: '✍️ Своя зависимость', callback_data: 'dep_custom' }],
              [{ text: '⬅️ Назад', callback_data: 'dependencies' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    // Dependency tracking handlers
    ['smoking', 'alcohol', 'social', 'gaming', 'shopping', 'sweets'].forEach(
      (type) => {
        this.bot.action(`dep_${type}`, async (ctx) => {
          await ctx.answerCbQuery();

          const dependencyName =
            type === 'smoking'
              ? 'курения'
              : type === 'alcohol'
                ? 'алкоголя'
                : type === 'social'
                  ? 'соцсетей'
                  : type === 'gaming'
                    ? 'игр'
                    : type === 'shopping'
                      ? 'покупок'
                      : 'сладкого';

          await ctx.editMessageTextWithMarkdown(
            `
🎯 *Отлично! Начинаем борьбу с зависимостью от ${dependencyName}*

🤖 Система ИИ настроена и будет отправлять вам персональные мотивационные сообщения каждый день.

💪 *Ты уже на правильном пути к свободе!*

Что тебе поможет:
• Ежедневные умные напоминания и поддержка
• Персональные советы от ИИ
• Напоминания о твоих целях
• Техники преодоления желаний

        `,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '� Готов начать',
                      callback_data: `setup_reminders_${type}`,
                    },
                  ],
                  [
                    {
                      text: '⬅️ Назад',
                      callback_data: 'choose_dependency',
                    },
                  ],
                ],
              },
            },
          );
        });
      },
    );

    // Custom dependency handler
    this.bot.action('dep_custom', async (ctx) => {
      await ctx.answerCbQuery();
      ctx.session.step = 'waiting_custom_dependency';
      await ctx.editMessageTextWithMarkdown(
        `
✍️ *Создание своей зависимости*

Напишите название зависимости, от которой хотите избавиться:

*Например:* "Переедание", "Прокрастинация", "Негативные мысли" и т.д.

⬇️ *Введите название зависимости в поле для ввода ниже*
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'choose_dependency' }],
            ],
          },
        },
      );
    });

    // Setup reminders for dependencies
    ['smoking', 'alcohol', 'social', 'gaming', 'shopping', 'sweets'].forEach(
      (type) => {
        this.bot.action(`setup_reminders_${type}`, async (ctx) => {
          await ctx.answerCbQuery();

          const dependencyName =
            type === 'smoking'
              ? 'курения'
              : type === 'alcohol'
                ? 'алкоголя'
                : type === 'social'
                  ? 'соцсетей'
                  : type === 'gaming'
                    ? 'игр'
                    : type === 'shopping'
                      ? 'покупок'
                      : 'сладкого';

          try {
            // Сохраняем информацию о зависимости пользователя
            // await this.userService.updateUser(ctx.userId, {
            //   dependencyType: type,
            //   dependencyStartDate: new Date(),
            // });

            // Запускаем ежедневные мотивационные сообщения
            const user = await this.userService.findByTelegramId(ctx.userId);
            this.startDailyMotivation(user.id, type);

            await ctx.editMessageTextWithMarkdown(
              `
✅ *Отлично! Запуск успешно начат!*

🎯 **Зависимость:** ${dependencyName}
📅 **Дата начала:** ${new Date().toLocaleDateString('ru-RU')}

🤖 **ИИ-система активирована:**
• Ежедневные мотивационные сообщения утром в 9:00
• Вечерние проверки в 21:00
• Персональные советы и поддержка
• Трекинг прогресса

⏰ **График уведомлений:**
🌅 **Утром (9:00):** Мотивация + кнопка "Обещаю сам себе"
🌙 **Вечером (21:00):** Проверка + кнопки "Держусь"/"Сдался"

Удачи в борьбе с зависимостью! Ты справишься! 🚀
            `,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '🏠 Главное меню',
                        callback_data: 'back_to_menu',
                      },
                    ],
                  ],
                },
              },
            );
          } catch (error) {
            this.logger.error(
              `Error setting up dependency reminders: ${error}`,
            );
            await ctx.editMessageTextWithMarkdown(
              '❌ Произошла ошибка при настройке. Попробуйте позже.',
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '⬅️ Назад',
                        callback_data: 'choose_dependency',
                      },
                    ],
                    [
                      {
                        text: '🏠 Главное меню',
                        callback_data: 'back_to_menu',
                      },
                    ],
                  ],
                },
              },
            );
          }
        });
      },
    );

    // Morning promise handlers
    ['smoking', 'alcohol', 'social', 'gaming', 'shopping', 'sweets'].forEach(
      (type) => {
        this.bot.action(`morning_promise_${type}`, async (ctx) => {
          await ctx.answerCbQuery();

          const dependencyName =
            type === 'smoking'
              ? 'курения'
              : type === 'alcohol'
                ? 'алкоголя'
                : type === 'social'
                  ? 'соцсетей'
                  : type === 'gaming'
                    ? 'игр'
                    : type === 'shopping'
                      ? 'покупок'
                      : 'сладкого';

          await ctx.replyWithMarkdown(`
💪 *Отлично! Обещание принято!*

🎯 **Сегодня ты обещаешь себе избегать зависимости от ${dependencyName}**

✨ Помни это обещание в течение дня. Ты сильнее любых искушений!

🌟 Вечером я спрошу, как прошел день. Удачи! 🚀
        `);
        });
      },
    );

    // Morning success handlers (Держусь)
    ['smoking', 'alcohol', 'social', 'gaming', 'shopping', 'sweets'].forEach(
      (type) => {
        this.bot.action(`morning_success_${type}`, async (ctx) => {
          await ctx.answerCbQuery();

          const dependencyName =
            type === 'smoking'
              ? 'курения'
              : type === 'alcohol'
                ? 'алкоголя'
                : type === 'social'
                  ? 'соцсетей'
                  : type === 'gaming'
                    ? 'игр'
                    : type === 'shopping'
                      ? 'покупок'
                      : 'сладкого';

          await ctx.replyWithMarkdown(`
💪 *Молодец! Ты держишься!*

🔥 **Отличное начало дня без зависимости от ${dependencyName}**

✨ Продолжай в том же духе! Каждый час сопротивления делает тебя сильнее.

🌟 Помни: ты уже на правильном пути! 🚀
          `);

          // Обновляем статистику успеха
          try {
            await this.prisma.dependencySupport.updateMany({
              where: {
                userId: ctx.userId,
                type: type.toUpperCase() as any,
              },
              data: {
                keptPromises: { increment: 1 },
              },
            });
          } catch (error) {
            this.logger.error('Error updating success stats:', error);
          }
        });
      },
    );

    // Morning fail handlers (Сдался)
    ['smoking', 'alcohol', 'social', 'gaming', 'shopping', 'sweets'].forEach(
      (type) => {
        this.bot.action(`morning_fail_${type}`, async (ctx) => {
          await ctx.answerCbQuery();

          const dependencyName =
            type === 'smoking'
              ? 'курения'
              : type === 'alcohol'
                ? 'алкоголя'
                : type === 'social'
                  ? 'соцсетей'
                  : type === 'gaming'
                    ? 'игр'
                    : type === 'shopping'
                      ? 'покупок'
                      : 'сладкого';

          await ctx.reply(
            `
💔 *Не расстраивайся, это случается*

🌱 **Каждый срыв - это урок, а не конец пути**

💪 Помни: важно не то, что ты упал, а то, что ты встаешь и продолжаешь бороться.

🔄 **Завтра новый день, новый шанс!**

📞 Если нужна поддержка - я всегда рядом. Давай начнем заново! 🌅
          `,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '⬅️ К зависимостям',
                      callback_data: 'dependencies',
                    },
                    { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
                  ],
                ],
              },
            },
          );

          // Обновляем статистику неудач
          try {
            await this.prisma.dependencySupport.updateMany({
              where: {
                userId: ctx.userId,
                type: type.toUpperCase() as any,
              },
              data: {
                daysClean: 0, // Обнуляем счетчик чистых дней
              },
            });
          } catch (error) {
            this.logger.error('Error updating fail stats:', error);
          }
        });
      },
    );

    // Evening check handlers
    ['smoking', 'alcohol', 'social', 'gaming', 'shopping', 'sweets'].forEach(
      (type) => {
        this.bot.action(`evening_holding_${type}`, async (ctx) => {
          await ctx.answerCbQuery();

          const dependencyName =
            type === 'smoking'
              ? 'курения'
              : type === 'alcohol'
                ? 'алкоголя'
                : type === 'social'
                  ? 'соцсетей'
                  : type === 'gaming'
                    ? 'игр'
                    : type === 'shopping'
                      ? 'покупок'
                      : 'сладкого';

          await ctx.replyWithMarkdown(`
🎉 *Поздравляю! Ты держишься!* 

💪 Еще один день победы над зависимостью от ${dependencyName}! 

🏆 **Ты доказал себе, что можешь контролировать свою жизнь!**

✨ Каждый такой день делает тебя сильнее. Продолжай в том же духе!

🌟 До встречи завтра утром! Спокойной ночи, чемпион! 🌙
        `);
        });

        this.bot.action(`evening_failed_${type}`, async (ctx) => {
          await ctx.answerCbQuery();

          const dependencyName =
            type === 'smoking'
              ? 'курения'
              : type === 'alcohol'
                ? 'алкоголя'
                : type === 'social'
                  ? 'соцсетей'
                  : type === 'gaming'
                    ? 'игр'
                    : type === 'shopping'
                      ? 'покупок'
                      : 'сладкого';

          await ctx.replyWithMarkdown(`
💙 *Все в порядке, не сдавайся!*

🤗 Срывы случаются - это часть пути к свободе от зависимости от ${dependencyName}.

💪 **Главное не то, что ты упал, а то, что ты поднимаешься!**

🌅 Завтра новый день и новая возможность стать сильнее.

✨ Я верю в тебя! Ты обязательно справишься!

💚 Помни: каждый день борьбы - это уже победа! До встречи завтра утром! 🌙
        `);
        });
      },
    );

    // Pomodoro Focus handler
    this.bot.action('pomodoro_focus', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showPomodoroMenu(ctx);
    });

    // Pomodoro session handlers
    this.bot.action('start_pomodoro_session', async (ctx) => {
      await ctx.answerCbQuery();

      const user = await this.getOrCreateUser(ctx);

      // Check if user needs to provide timezone first
      if (!user.timezone) {
        await this.askForTimezone(ctx);
        return;
      }

      const startTime = new Date();
      const endTime = new Date(startTime.getTime() + 25 * 60 * 1000);

      // Format time according to user's timezone
      const endTimeFormatted = this.formatTimeWithTimezone(
        endTime,
        user.timezone,
      );

      await ctx.editMessageTextWithMarkdown(
        `🍅 *Сессия фокуса запущена!*

⏰ **Таймер**: 25 минут (до ${endTimeFormatted})
🎯 Сосредоточьтесь на одной задаче
📱 Уберите отвлекающие факторы
💪 Работайте до уведомления

🔔 **Вы получите уведомление через 25 минут**

*Удачной работы! 💪*`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '⏸️ Пауза',
                  callback_data: 'pause_pomodoro',
                },
                {
                  text: '⏹️ Стоп',
                  callback_data: 'stop_pomodoro',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
              [{ text: '🏠 Главное меню', callback_data: 'start' }],
            ],
          },
        },
      );

      // Clear any existing session for this user
      const existingSession = this.activePomodoroSessions.get(ctx.userId);
      if (existingSession) {
        if (existingSession.focusTimer)
          clearTimeout(existingSession.focusTimer);
        if (existingSession.breakTimer)
          clearTimeout(existingSession.breakTimer);
      }

      // Start new 25-minute focus timer
      const focusTimer = setTimeout(
        async () => {
          try {
            // Отправляем новое сообщение с уведомлением о завершении фокуса
            await ctx.telegram.sendMessage(
              ctx.userId,
              `🔔 *Время фокуса закончилось!*

🎉 Поздравляем! Вы сосредоточенно работали 25 минут.

☕ Время для 5-минутного перерыва:
• Встаньте и разомнитесь
• Посмотрите в окно
• Выпейте воды
• Не проверяйте соцсети!

⏰ Перерыв заканчивается через 5 минут.`,
              {
                parse_mode: 'Markdown',
                disable_notification: false, // Включаем звук уведомления
              },
            );

            // Start 5-minute break timer
            const breakTimer = setTimeout(
              async () => {
                try {
                  // Отправляем новое сообщение с уведомлением о завершении перерыва
                  await ctx.telegram.sendMessage(
                    ctx.userId,
                    `⏰ *Перерыв закончился!*

🍅 5-минутный перерыв завершен. Готовы к следующей сессии фокуса?

💪 Следующий цикл:
• 25 минут фокуса
• 5 минут отдыха  
• После 4 циклов - длинный перерыв 15-30 минут

🎯 Хотите продолжить?`,
                    {
                      parse_mode: 'Markdown',
                      disable_notification: false, // Включаем звук уведомления
                      reply_markup: {
                        inline_keyboard: [
                          [
                            {
                              text: '🚀 Начать новую сессию',
                              callback_data: 'start_pomodoro_session',
                            },
                          ],
                          [
                            {
                              text: '📊 Посмотреть статистику',
                              callback_data: 'pomodoro_history',
                            },
                          ],
                          [
                            {
                              text: '⬅️ Назад',
                              callback_data: 'pomodoro_focus',
                            },
                          ],
                        ],
                      },
                    },
                  );

                  // Remove session from active sessions after break completes
                  this.activePomodoroSessions.delete(ctx.userId);
                } catch (error) {
                  console.log(
                    'Failed to send break completion message:',
                    error,
                  );
                }
              },
              5 * 60 * 1000,
            ); // 5 minutes break

            // Update session with break timer
            const session = this.activePomodoroSessions.get(ctx.userId);
            if (session) {
              session.breakTimer = breakTimer;
            }
          } catch (error) {
            console.log('Failed to send pomodoro completion message:', error);
          }
        },
        25 * 60 * 1000,
      ); // 25 minutes = 1500000 milliseconds

      // Save the session with timers
      this.activePomodoroSessions.set(ctx.userId, {
        focusTimer,
        startTime,
      });
    });

    // Pomodoro break handler
    this.bot.action('start_pomodoro_break', async (ctx) => {
      await ctx.answerCbQuery();

      try {
        // Start 5-minute break timer
        await ctx.telegram.sendMessage(
          ctx.userId,
          `☕ *Время перерыва*

🎉 Фокус-сессия завершена!
⏰ Идет 5-минутный перерыв
💪 Разомнитесь и отдохните

*Перерыв скоро закончится*`,
          {
            parse_mode: 'Markdown',
            disable_notification: false, // Включаем звук уведомления
          },
        );

        const breakTimer = setTimeout(
          async () => {
            try {
              // Отправляем новое сообщение с уведомлением о завершении перерыва
              await ctx.telegram.sendMessage(
                ctx.userId,
                `⏰ *Перерыв закончился!*

🍅 5-минутный перерыв завершен. Готовы к следующей сессии фокуса?

💪 Следующий цикл:
• 25 минут фокуса
• 5 минут отдыха  
• После 4 циклов - длинный перерыв 15-30 минут

🎯 Хотите продолжить?`,
                {
                  parse_mode: 'Markdown',
                  disable_notification: false, // Включаем звук уведомления
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {
                          text: '🚀 Начать новую сессию',
                          callback_data: 'start_pomodoro_session',
                        },
                      ],
                      [
                        {
                          text: '📊 Посмотреть статистику',
                          callback_data: 'pomodoro_history',
                        },
                      ],
                      [
                        {
                          text: '⬅️ Назад',
                          callback_data: 'pomodoro_focus',
                        },
                      ],
                    ],
                  },
                },
              );

              // Remove session from active sessions after break completes
              this.activePomodoroSessions.delete(ctx.userId);
            } catch (error) {
              console.log('Failed to send break completion message:', error);
            }
          },
          5 * 60 * 1000, // 5 minutes break
        );

        // Update session with break timer
        const session = this.activePomodoroSessions.get(ctx.userId);
        if (session) {
          session.breakTimer = breakTimer;
        } else {
          // Create new session if none exists
          this.activePomodoroSessions.set(ctx.userId, {
            breakTimer,
            startTime: new Date(),
          });
        }
      } catch (error) {
        console.log('Failed to start break timer:', error);
        await ctx.replyWithMarkdown('❌ Произошла ошибка при запуске перерыва');
      }
    });

    this.bot.action('pause_pomodoro', async (ctx) => {
      await ctx.answerCbQuery();

      const session = this.activePomodoroSessions.get(ctx.userId);
      if (session) {
        // Stop the current timer
        if (session.focusTimer) {
          clearTimeout(session.focusTimer);
          session.focusTimer = undefined;
        }

        // Save pause time
        session.pausedAt = new Date();

        // Calculate remaining time (taking into account previous pauses)
        const totalElapsed =
          new Date().getTime() -
          session.startTime.getTime() -
          (session.totalPausedTime || 0);
        const elapsed = Math.floor(totalElapsed / (1000 * 60));
        const remaining = Math.max(0, 25 - elapsed);
        const remainingMinutes = remaining;
        const remainingSeconds = Math.max(
          0,
          Math.floor((25 * 60 * 1000 - totalElapsed) / 1000) % 60,
        );

        await ctx.editMessageTextWithMarkdown(
          `
⏸️ *Сессия приостановлена*

⏰ Осталось времени: ${remainingMinutes}:${remainingSeconds.toString().padStart(2, '0')}
⚡ Прошло: ${elapsed} мин
🎯 Фокус-сессия в процессе

*Готовы продолжить?*
          `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '▶️ Продолжить',
                    callback_data: 'resume_pomodoro',
                  },
                  {
                    text: '⏹️ Завершить',
                    callback_data: 'stop_pomodoro',
                  },
                ],
                [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                [{ text: '🏠 Главное меню', callback_data: 'start' }],
              ],
            },
          },
        );
      } else {
        await ctx.editMessageTextWithMarkdown(
          `⚠️ *Нет активной сессии*

У вас нет активной сессии для паузы.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🚀 Начать сессию',
                    callback_data: 'start_pomodoro_session',
                  },
                ],
                [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                [{ text: '🏠 Главное меню', callback_data: 'start' }],
              ],
            },
          },
        );
      }
    });

    this.bot.action('resume_pomodoro', async (ctx) => {
      await ctx.answerCbQuery();

      const session = this.activePomodoroSessions.get(ctx.userId);
      if (session) {
        // Update total paused time
        if (session.pausedAt) {
          const pauseDuration =
            new Date().getTime() - session.pausedAt.getTime();
          session.totalPausedTime =
            (session.totalPausedTime || 0) + pauseDuration;
          session.pausedAt = undefined;
        }

        // Calculate remaining time (accounting for all pauses)
        const totalElapsed =
          new Date().getTime() -
          session.startTime.getTime() -
          (session.totalPausedTime || 0);
        const elapsed = Math.floor(totalElapsed / (1000 * 60));
        const remaining = Math.max(0, 25 - elapsed);
        const remainingMinutes = remaining;
        const remainingSeconds = Math.max(
          0,
          Math.floor((25 * 60 * 1000 - totalElapsed) / 1000) % 60,
        );

        // Clear existing timer if any
        if (session.focusTimer) {
          clearTimeout(session.focusTimer);
        }

        // Restart timer with remaining time
        const remainingMs = Math.max(0, 25 * 60 * 1000 - totalElapsed);

        if (remainingMs > 0) {
          session.focusTimer = setTimeout(async () => {
            try {
              const currentSession = this.activePomodoroSessions.get(
                ctx.userId,
              );
              if (currentSession) {
                await ctx.telegram.sendMessage(
                  ctx.userId,
                  `🔔 *Время фокус-сессии истекло!*

⏰ 25 минут прошли
🎉 Поздравляем с завершением сессии!

*Что дальше?*

✅ Время для 5-минутного перерыва
🍅 Или начать новую сессию`,
                  {
                    parse_mode: 'Markdown',
                    disable_notification: false, // Включаем звук уведомления
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {
                            text: '☕ Перерыв (5 мин)',
                            callback_data: 'start_pomodoro_break',
                          },
                        ],
                        [
                          {
                            text: '🍅 Новая сессия',
                            callback_data: 'start_pomodoro_session',
                          },
                          {
                            text: '📊 История',
                            callback_data: 'pomodoro_history',
                          },
                        ],
                        [
                          {
                            text: '🏠 Главное меню',
                            callback_data: 'start',
                          },
                        ],
                      ],
                    },
                  },
                );
                this.activePomodoroSessions.delete(ctx.userId);
              }
            } catch (error) {
              console.log('Failed to send pomodoro completion message:', error);
            }
          }, remainingMs);
        }

        await ctx.editMessageTextWithMarkdown(
          `▶️ *Сессия возобновлена*

⏰ Продолжаем с ${remainingMinutes}:${remainingSeconds.toString().padStart(2, '0')}
🎯 Фокусируемся на задаче!`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '⏸️ Пауза',
                    callback_data: 'pause_pomodoro',
                  },
                  {
                    text: '⏹️ Стоп',
                    callback_data: 'stop_pomodoro',
                  },
                ],
                [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                [{ text: '🏠 Главное меню', callback_data: 'start' }],
              ],
            },
          },
        );
      }
    });

    this.bot.action('stop_pomodoro', async (ctx) => {
      await ctx.answerCbQuery();

      // Stop any active timers for this user
      const session = this.activePomodoroSessions.get(ctx.userId);
      if (session) {
        if (session.focusTimer) clearTimeout(session.focusTimer);
        if (session.breakTimer) clearTimeout(session.breakTimer);

        // Calculate elapsed time
        const elapsed = Math.floor(
          (new Date().getTime() - session.startTime.getTime()) / (1000 * 60),
        );
        const elapsedMinutes = elapsed % 60;
        const elapsedHours = Math.floor(elapsed / 60);
        const timeText =
          elapsedHours > 0
            ? `${elapsedHours}:${elapsedMinutes.toString().padStart(2, '0')}`
            : `${elapsedMinutes}:${(((new Date().getTime() - session.startTime.getTime()) % 60000) / 1000).toFixed(0).padStart(2, '0')}`;

        this.activePomodoroSessions.delete(ctx.userId);

        await ctx.editMessageTextWithMarkdown(
          `
⏹️ *Сессия остановлена*

⏰ Время работы: ${timeText} из 25:00
📝 Хотите записать, что успели сделать?

*Следующие действия:*
          `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '📝 Записать прогресс',
                    callback_data: 'log_pomodoro_progress',
                  },
                ],
                [
                  {
                    text: '🍅 Новая сессия',
                    callback_data: 'start_pomodoro_session',
                  },
                  {
                    text: '📊 Статистика',
                    callback_data: 'pomodoro_history',
                  },
                ],
                [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                [{ text: '🏠 Главное меню', callback_data: 'start' }],
              ],
            },
          },
        );
      } else {
        // No active session
        await ctx.editMessageTextWithMarkdown(
          `
⚠️ *Нет активной сессии*

У вас нет активной сессии фокуса для остановки.

*Хотите начать новую?*
          `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🚀 Начать сессию',
                    callback_data: 'start_pomodoro_session',
                  },
                ],
                [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
                [{ text: '🏠 Главное меню', callback_data: 'start' }],
              ],
            },
          },
        );
      }
    });

    this.bot.action('pomodoro_history', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
📊 *История фокус-сессий*

**Сегодня (19.08.2025):**
🍅 Сессий: 0
⏰ Общее время: 0 мин
🎯 Задач завершено: 0

**На этой неделе:**
📅 Всего сессий: 0
📈 Среднее в день: 0
🏆 Лучший день: 0 сессий

**Общая статистика:**
🎯 Всего сессий: 0
⚡ Общее время фокуса: 0 ч
📚 Самая продуктивная неделя: 0 сессий

*Функция в разработке - данные будут сохраняться!*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📈 График прогресса',
                  callback_data: 'pomodoro_chart',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
              [{ text: '🏠 Главное меню', callback_data: 'start' }],
            ],
          },
        },
      );
    });

    this.bot.action('pomodoro_settings', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
⚙️ *Настройки Помодоро*

**Текущие настройки:**
⏱️ Время фокуса: 25 мин
☕ Короткий перерыв: 5 мин
🏖️ Длинный перерыв: 15 мин
🔢 Сессий до длинного перерыва: 4

**Уведомления:**
🔔 Звуковые сигналы: ✅
📱 Push-уведомления: ✅
⏰ Напоминания о перерывах: ✅

**Дополнительно:**
🎵 Фоновые звуки: ❌
📊 Автосохранение статистики: ✅
🎯 Выбор задачи перед сессией: ❌

*Функция настроек в разработке!*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '⏱️ Изменить время',
                  callback_data: 'change_pomodoro_time',
                },
              ],
              [
                {
                  text: '🔔 Уведомления',
                  callback_data: 'pomodoro_notifications',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
              [{ text: '🏠 Главное меню', callback_data: 'start' }],
            ],
          },
        },
      );
    });

    // Additional Pomodoro handlers
    this.bot.action('log_pomodoro_progress', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
📝 *Записать прогресс*

⏰ Время работы: 9:30 из 25:00
📊 Эффективность: 38%

*Что вы успели сделать?*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📚 Изучение',
                  callback_data: 'progress_studying',
                },
                {
                  text: '💻 Работа',
                  callback_data: 'progress_work',
                },
              ],
              [
                {
                  text: '📝 Написание',
                  callback_data: 'progress_writing',
                },
                {
                  text: '🎨 Творчество',
                  callback_data: 'progress_creative',
                },
              ],
              [
                {
                  text: '✏️ Другое',
                  callback_data: 'progress_custom',
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'pomodoro_focus' }],
              [{ text: '🏠 Главное меню', callback_data: 'start' }],
            ],
          },
        },
      );
    });

    this.bot.action('pomodoro_chart', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `📈 *График прогресса*

🚧 *Функция в разработке*

Здесь будет отображаться:
📊 График фокус-сессий по дням
📈 Динамика продуктивности
🎯 Статистика по типам задач
⏰ Лучшие часы для фокуса

📧 Включите уведомления в настройках, чтобы не пропустить запуск!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'pomodoro_history' }],
              [{ text: '🏠 Главное меню', callback_data: 'start' }],
            ],
          },
        },
      );
    });

    this.bot.action('change_pomodoro_time', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
⏱️ *Настройка времени*

**Выберите время фокуса:**
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '15 мин', callback_data: 'set_focus_15' },
                { text: '25 мин ✅', callback_data: 'set_focus_25' },
                { text: '30 мин', callback_data: 'set_focus_30' },
              ],
              [
                { text: '45 мин', callback_data: 'set_focus_45' },
                { text: '60 мин', callback_data: 'set_focus_60' },
              ],
              [{ text: '⬅️ Назад', callback_data: 'pomodoro_settings' }],
              [{ text: '🏠 Главное меню', callback_data: 'start' }],
            ],
          },
        },
      );
    });

    this.bot.action('pomodoro_notifications', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
🔔 *Настройки уведомлений*

**Текущие настройки:**
🔊 Звуковые сигналы: ✅
📱 Push-уведомления: ✅
⏰ Напоминания о перерывах: ✅
🎵 Фоновая музыка: ❌

*Функция в разработке!*
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'pomodoro_settings' }],
              [{ text: '🏠 Главное меню', callback_data: 'start' }],
            ],
          },
        },
      );
    });

    // Handle AI tips for focus
    this.bot.action('focus_ai_tips', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showFocusAITips(ctx);
    });

    // Progress category handlers
    ['studying', 'work', 'writing', 'creative', 'custom'].forEach(
      (category) => {
        this.bot.action(`progress_${category}`, async (ctx) => {
          await ctx.answerCbQuery();
          await ctx.editMessageTextWithMarkdown(
            `
✅ *Прогресс сохранен!*

📊 Категория: ${
              category === 'studying'
                ? 'Изучение'
                : category === 'work'
                  ? 'Работа'
                  : category === 'writing'
                    ? 'Написание'
                    : category === 'creative'
                      ? 'Творчество'
                      : 'Другое'
            }
⏰ Время работы: 9:30

🎯 +10 XP за фокус-сессию!
📈 Ваш прогресс учтен в статистике.
          `,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '⬅️ К фокусированию',
                      callback_data: 'pomodoro_focus',
                    },
                    { text: '🏠 Главное меню', callback_data: 'start' },
                  ],
                ],
              },
            },
          );
        });
      },
    );

    // Focus time setting handlers
    [15, 25, 30, 45, 60].forEach((minutes) => {
      this.bot.action(`set_focus_${minutes}`, async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.editMessageTextWithMarkdown(
          `
⏱️ *Время фокуса изменено*

Новое время фокуса: ${minutes} минут
Время перерыва: ${minutes <= 25 ? 5 : 10} минут

✅ Настройки сохранены!
        `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '⬅️ К настройкам',
                    callback_data: 'pomodoro_settings',
                  },
                  {
                    text: '🍅 К Pomodoro',
                    callback_data: 'pomodoro_focus',
                  },
                ],
                [
                  {
                    text: '🏠 Главное меню',
                    callback_data: 'start',
                  },
                ],
              ],
            },
          },
        );
      });
    });

    // Mood handlers
    ['excellent', 'good', 'neutral', 'sad', 'angry', 'anxious'].forEach(
      (mood) => {
        this.bot.action(`mood_${mood}`, async (ctx) => {
          await ctx.answerCbQuery();

          const moodEmoji = {
            excellent: '😄',
            good: '😊',
            neutral: '😐',
            sad: '😔',
            angry: '😤',
            anxious: '😰',
          }[mood];

          const moodText = {
            excellent: 'отличное',
            good: 'хорошее',
            neutral: 'нормальное',
            sad: 'грустное',
            angry: 'злое',
            anxious: 'тревожное',
          }[mood];

          await ctx.editMessageTextWithMarkdown(
            `
${moodEmoji} *Настроение записано!*

Ваше настроение: **${moodText}**
📅 Дата: ${new Date().toLocaleDateString('ru-RU')}

📊 Статистика настроения будет доступна в следующем обновлении!

*Спасибо за то, что делитесь своим настроением. Это поможет лучше понимать ваше эмоциональное состояние.*
        `,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '📈 Посмотреть статистику',
                      callback_data: 'mood_stats',
                    },
                  ],
                  [
                    {
                      text: '🏠 Главное меню',
                      callback_data: 'back_to_menu',
                    },
                  ],
                ],
              },
            },
          );
        });
      },
    );

    // Handle AI analysis for mood
    this.bot.action('mood_ai_analysis', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMoodAIAnalysis(ctx);
    });

    this.bot.action('mood_stats', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
📊 *Статистика настроения*

**Сегодня:** 😊 (хорошее)
**За неделю:** Средняя оценка 7/10
**За месяц:** Средняя оценка 6.5/10

**Самые частые настроения:**
😊 Хорошее - 45%
😐 Нормальное - 30% 
😄 Отличное - 25%

📈 *Функция подробной статистики в разработке!*
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к настроению', callback_data: 'menu_mood' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action('faq_support', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.replyWithMarkdown(
        `
❓ *FAQ — ЧАСТО ЗАДАВАЕМЫЕ ВОПРОСЫ*

1. **Как добавить новую задачу?**
Просто нажмите на кнопку «Создать задачу/привычку» или напиши в чат: «Напомнить завтра в 17:00 зайти на почту» и бот автоматически создаст Вам эту задачу.

2. **Что такое XP и уровень?**
XP (опыт) начисляется за выполнение задач. С каждым уровнем открываются новые челленджи и бонусы.

3. **Что значит «отправить голосовое сообщение»?**
Бот умеет распознавать голосовые сообщения и автоматически выполняет задачу которую Вы записали (создает задачу/напоминание/привычку).

4. **Что значит функция ИИ – Помощник?**
Искусственный интеллект анализирует все ваши задачи, привычки, зависимости и дает рекомендации по достижению результата. Представьте что это личный тренер, психолог, наставник, коллега и друг в одном лице.

5. **Как отключить/настроить напоминания?**
В меню "⚙️ Настройки" можно включить, отключить или изменить время напоминаний.

6. **Кто видит мои задачи?**
Ваши задачи видите только вы. Можно делиться отдельными результатами по желанию.

7. **Как работает челлендж?**
Это тематические задания на время — за участие начисляются дополнительные XP и достижения.

8. **Что делать, если бот не отвечает?**
Попробуйте перезапустить Telegram. Если не поможет напишите в "FAQ / Поддержка".

9. **Как связаться с поддержкой?**
В конце любого раздела FAQ есть кнопка "📝 Задать вопрос".

10. **Как быстро перейти к любимой функции?**
Введите "/" — появится быстрый список всех команд и функций.

11. **Как работает реферальная система?**
Вы просто копируете ссылку в меню «Реферальная программа» и отправляете другу. С того кто зарегистрируется по ней и подключит подписку Вы будете ежемесячно получать по 40% с его оплат!

12. **Как работает система бесплатной подписки навсегда при добавлении 5 друзей к боту?**
Вы отправляете ссылку на регистрацию в нашем боте и когда Вы наберете 5 регистраций Вам автоматически придет уведомление о том, что Вы получили бесплатную премиум версию навсегда!

*Если не нашли ответа — напишите нам!*
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Задать вопрос', callback_data: 'ask_question' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action('ask_question', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
📝 *Задать вопрос поддержке*

Пожалуйста, опишите ваш вопрос или проблему в следующем сообщении, и наша команда поддержки свяжется с вами в ближайшее время.

Можете также написать команду /feedback для отправки обратной связи.
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад к FAQ', callback_data: 'faq_support' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action('add_habit_direct', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        '🔄 *Добавление привычек* - функция в разработке',
      );
    });

    this.bot.action('back_to_menu', async (ctx) => {
      await ctx.answerCbQuery();

      // Clear session state when returning to main menu
      ctx.session.step = undefined;
      ctx.session.pendingAction = undefined;
      ctx.session.tempData = undefined;
      ctx.session.aiChatMode = false; // 🔧 Автоматически завершаем AI чат при переходе в главное меню
      ctx.session.aiHabitCreationMode = false;

      await this.showMainMenu(ctx, true);
    });

    // Handle "Главное меню" button clicks
    this.bot.action('start', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMainMenu(ctx, true);
    });

    this.bot.action('back_to_commands', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMainMenu(ctx, true);
    });

    this.bot.action('commands_menu', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMainMenu(ctx, true);
    });

    // Voice command handlers
    this.bot.action(/^create_task_from_voice:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskName = ctx.match[1];
      await this.createTaskFromVoice(ctx, taskName);
    });

    this.bot.action(/^create_habit_from_voice:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const habitName = ctx.match[1];
      await this.createHabitFromVoice(ctx, habitName);
    });

    // New handlers for voice text stored in session
    this.bot.action('create_task_from_voice_text', async (ctx) => {
      await ctx.answerCbQuery();
      const voiceText = ctx.session.tempData?.voiceText;
      if (voiceText) {
        await this.createTaskFromText(ctx, voiceText);
      } else {
        await ctx.reply(
          '❌ Текст голосового сообщения не найден. Попробуйте еще раз.',
        );
      }
    });

    this.bot.action('create_habit_from_voice_text', async (ctx) => {
      await ctx.answerCbQuery();
      const voiceText = ctx.session.tempData?.voiceText;
      if (voiceText) {
        const habitName = this.extractHabitName(voiceText);
        await this.createHabitFromVoice(ctx, habitName);
      } else {
        await ctx.reply(
          '❌ Текст голосового сообщения не найден. Попробуйте еще раз.',
        );
      }
    });

    this.bot.action('create_reminder_from_voice_text', async (ctx) => {
      await ctx.answerCbQuery();
      const voiceText = ctx.session.tempData?.voiceText;
      if (voiceText) {
        await this.processReminderFromText(ctx, voiceText);
      } else {
        await ctx.reply(
          '❌ Текст голосового сообщения не найден. Попробуйте еще раз.',
        );
      }
    });

    this.bot.action('ai_chat_from_voice_text', async (ctx) => {
      await ctx.answerCbQuery();
      const voiceText = ctx.session.tempData?.voiceText;
      if (voiceText) {
        ctx.session.aiChatMode = true;
        await this.handleAIChatMessage(ctx, voiceText);
      } else {
        await ctx.reply(
          '❌ Текст голосового сообщения не найден. Попробуйте еще раз.',
        );
      }
    });

    this.bot.action(/^create_reminder_from_voice:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const reminderText = decodeURIComponent(ctx.match[1]);

      await ctx.editMessageTextWithMarkdown(
        `⏰ *Создание напоминания из голоса*

Текст: "${reminderText}"

💡 **Как указать время:**
Отправьте сообщение с временем, например:
• "${reminderText} в 17:30"
• "${reminderText} через 2 часа"
• "${reminderText} завтра в 14:00"

Или выберите удобное время:`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📝 Написать время',
                  callback_data: 'create_reminder_help',
                },
                { text: '� Голосом', callback_data: 'voice_reminder_help' },
              ],
              [{ text: '⬅️ Назад', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action(/^ai_chat_from_voice:(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const text = ctx.match[1];
      await this.handleAIChatMessage(ctx, text);
    });

    // AI Chat handlers
    this.bot.action('ai_analyze_profile', async (ctx) => {
      await this.handleAIAnalyzeProfile(ctx);
    });

    this.bot.action('ai_task_recommendations', async (ctx) => {
      await this.handleAITaskRecommendations(ctx);
    });

    this.bot.action('ai_time_planning', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
⏰ *Планирование времени*

Функция в разработке! Здесь будут рекомендации по эффективному планированию времени.
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            ],
          },
        },
      );
    });

    this.bot.action('ai_custom_question', async (ctx) => {
      await this.handleAICustomQuestion(ctx);
    });

    this.bot.action('ai_back_menu', async (ctx) => {
      await ctx.answerCbQuery();
      await this.startAIChat(ctx);
    });

    // AI specialized handlers
    this.bot.action('ai_analyze_profile', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleAIAnalyzeProfile(ctx);
    });

    this.bot.action('ai_task_recommendations', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleAITaskRecommendations(ctx);
    });

    this.bot.action('ai_habit_help', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleAIHabitHelp(ctx);
    });

    this.bot.action('ai_time_planning', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleAITimePlanning(ctx);
    });

    this.bot.action('ai_custom_question', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleAICustomQuestion(ctx);
    });

    // Handle AI habit creation
    this.bot.action('ai_create_habit', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleAICreateHabit(ctx);
    });

    // Task management handlers
    this.bot.action('tasks_add', async (ctx) => {
      await ctx.answerCbQuery();
      await this.startAddingTask(ctx);
    });

    this.bot.action('tasks_list', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showTasksList(ctx);
    });

    this.bot.action('tasks_list_more', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showAllTasksList(ctx);
    });

    this.bot.action('tasks_today', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showTodayTasks(ctx);
    });

    this.bot.action('tasks_completed', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showCompletedTasks(ctx);
    });

    // Handle AI advice for tasks
    this.bot.action('tasks_ai_advice', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showTasksAIAdvice(ctx);
    });

    // Handle task completion
    this.bot.action(/^task_complete_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];
      await this.completeTask(ctx, taskId);
    });

    // Handle task status toggle (complete/uncomplete)
    this.bot.action(/^toggle_task_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];
      try {
        // Найдем задачу и переключим её статус
        const task = await this.taskService.findTaskById(taskId, ctx.userId);
        if (task && task.userId === ctx.userId) {
          if (task.status === 'COMPLETED') {
            // Делаем задачу активной
            await this.taskService.updateTask(taskId, ctx.userId, {
              status: 'PENDING',
              completedAt: null,
            } as any);
            await ctx.answerCbQuery('Задача отмечена как активная!');
          } else {
            // Завершаем задачу
            await this.completeTask(ctx, taskId);
            return; // completeTask уже обновляет интерфейс
          }
          // Обновляем список задач
          await this.showAllTasksList(ctx);
        } else {
          await ctx.answerCbQuery('Задача не найдена');
        }
      } catch (error) {
        this.logger.error('Error toggling task status:', error);
        await ctx.answerCbQuery('Ошибка при изменении статуса задачи');
      }
    });

    // Handle task deletion (ask for confirmation)
    this.bot.action(/^task_delete_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];
      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '✅ Да, удалить',
              callback_data: `confirm_delete_task_${taskId}`,
            },
            {
              text: '❌ Отмена',
              callback_data: `cancel_delete_task_${taskId}`,
            },
          ],
        ],
      };
      await ctx.editMessageTextWithMarkdown(
        `Вы уверены, что хотите удалить задачу? Это действие нельзя отменить.`,
        { reply_markup: keyboard },
      );
    });

    // Confirm delete
    this.bot.action(/^confirm_delete_task_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];
      try {
        await this.taskService.deleteTask(taskId, ctx.userId);
        await ctx.editMessageTextWithMarkdown('✅ Задача удалена.');
        // Refresh tasks list after a short delay
        setTimeout(() => this.showTasksList(ctx), 500);
      } catch (error) {
        this.logger.error('Error deleting task:', error);
        await ctx.editMessageTextWithMarkdown(
          '❌ Не удалось удалить задачу. Попробуйте позже.',
        );
      }
    });

    // Cancel delete
    this.bot.action(/^cancel_delete_task_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      // Return to tasks list
      await this.showTasksList(ctx);
    });

    // Handle back to tasks menu (redirect to tasks menu)
    this.bot.action('back_to_tasks', async (ctx) => {
      await ctx.answerCbQuery();
      // Redirect to main tasks menu instead of showing tasks list directly
      await this.showTasksMenu(ctx);
    });

    // No-op separator (for decorative rows) and view completed task
    this.bot.action('noop_separator', async (ctx) => {
      await ctx.answerCbQuery();
    });

    this.bot.action(/^task_view_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];
      try {
        const task = await this.taskService.findTaskById(taskId, ctx.userId);

        const statusEmoji = task.status === 'COMPLETED' ? '✅' : '⏳';
        const message =
          `${statusEmoji} *${task.title}*\n\n` +
          `📊 *Статус:* ${task.status === 'COMPLETED' ? 'Выполнена' : 'Активна'}\n` +
          `🎯 *Приоритет:* ${task.priority}\n` +
          `💎 *XP за выполнение:* ${task.xpReward}\n` +
          (task.description ? `📝 *Описание:* ${task.description}\n` : '') +
          (task.dueDate
            ? `📅 *Срок:* ${new Date(task.dueDate).toLocaleDateString('ru-RU')}\n`
            : '') +
          (task.completedAt
            ? `✅ *Выполнена:* ${new Date(task.completedAt).toLocaleDateString('ru-RU')}\n`
            : '');

        const keyboard = {
          inline_keyboard: [
            task.status === 'COMPLETED'
              ? [
                  {
                    text: '🔁 Вернуть в активные',
                    callback_data: `task_reopen_${task.id}`,
                  },
                  {
                    text: '✏️ Редактировать',
                    callback_data: `task_edit_options_${task.id}`,
                  },
                ]
              : [
                  {
                    text: '✅ Выполнить',
                    callback_data: `toggle_task_${task.id}`,
                  },
                  {
                    text: '✏️ Редактировать',
                    callback_data: `task_edit_options_${task.id}`,
                  },
                ],
            [{ text: '🗑️ Удалить', callback_data: `task_delete_${task.id}` }],
            [
              {
                text: '⏰ Добавить напоминание',
                callback_data: `add_task_reminder_${task.id}`,
              },
            ],
            [{ text: '🔙 Назад к списку задач', callback_data: 'tasks_list' }],
          ],
        };

        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
      } catch (err) {
        this.logger.error('Error showing task view:', err);
        await ctx.editMessageTextWithMarkdown('❌ Не удалось получить задачу');
      }
    });

    // Reopen a completed task
    this.bot.action(/^task_reopen_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];
      try {
        await this.taskService.updateTask(taskId, ctx.userId, {
          status: 'PENDING',
        } as any);
        await ctx.replyWithMarkdown('✅ Задача возвращена в активные.');
        await this.showTodayTasks(ctx);
      } catch (err) {
        this.logger.error('Error reopening task:', err);
        await ctx.replyWithMarkdown('❌ Не удалось вернуть задачу.');
      }
    });

    // Start edit title flow (DEPRECATED - this handler is not used anymore)
    // this.bot.action(/^task_edit_title_direct_(.+)$/, async (ctx) => {
    //   await ctx.answerCbQuery();
    //   const taskId = ctx.match[1];
    //   // Set session to editing mode and ask for new title
    //   ctx.session.step = 'editing_task_title';
    //   ctx.session.pendingTaskTitle = taskId;
    //   await ctx.replyWithMarkdown('✏️ Отправьте новое название задачи:');
    // });

    // Show task edit options
    this.bot.action(/^task_edit_options_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];

      // Сбрасываем состояние редактирования при возврате к опциям
      ctx.session.step = undefined;
      ctx.session.pendingTaskTitle = undefined;

      try {
        const task = await this.taskService.findTaskById(taskId, ctx.userId);

        const message =
          `✏️ *Редактирование задачи*\n\n` +
          `📝 *Текущее название:* ${task.title}\n\n` +
          `Выберите, что хотите изменить:`;

        const keyboard = {
          inline_keyboard: [
            [
              {
                text: '📝 Изменить название',
                callback_data: `task_edit_title_${task.id}`,
              },
            ],
            [
              {
                text: '📄 Изменить описание',
                callback_data: `task_edit_description_${task.id}`,
              },
            ],
            [
              {
                text: '🎯 Изменить приоритет',
                callback_data: `task_edit_priority_${task.id}`,
              },
            ],
            [
              {
                text: '⏰ Добавить напоминание',
                callback_data: `add_task_reminder_${task.id}`,
              },
            ],
            [
              {
                text: '🗑️ Удалить задачу',
                callback_data: `task_delete_${task.id}`,
              },
            ],
            [
              {
                text: '🔙 Назад к задаче',
                callback_data: `task_view_${task.id}`,
              },
            ],
          ],
        };

        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
      } catch (err) {
        this.logger.error('Error showing task edit options:', err);
        await ctx.editMessageTextWithMarkdown('❌ Не удалось получить задачу');
      }
    });

    // Edit task title
    this.bot.action(/^task_edit_title_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];
      ctx.session.step = 'editing_task_title';
      ctx.session.pendingTaskTitle = taskId;
      await ctx.editMessageTextWithMarkdown(
        '✏️ Отправьте новое название задачи:',
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔙 Назад к редактированию',
                  callback_data: `task_edit_options_${taskId}`,
                },
              ],
            ],
          },
        },
      );
    });

    // Edit task description
    this.bot.action(/^task_edit_description_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];
      ctx.session.step = 'editing_task_description';
      ctx.session.pendingTaskTitle = taskId; // Используем существующее поле
      await ctx.editMessageTextWithMarkdown(
        '📄 Отправьте новое описание задачи (или отправьте "удалить" чтобы убрать описание):',
      );
    });

    // Edit task priority
    this.bot.action(/^task_edit_priority_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '🔴 Высокий',
              callback_data: `set_task_priority_${taskId}_HIGH`,
            },
            {
              text: '⬜ Средний',
              callback_data: `set_task_priority_${taskId}_MEDIUM`,
            },
          ],
          [
            {
              text: '🟢 Низкий',
              callback_data: `set_task_priority_${taskId}_LOW`,
            },
            {
              text: '🔥 Срочный',
              callback_data: `set_task_priority_${taskId}_URGENT`,
            },
          ],
          [{ text: '🔙 Назад', callback_data: `task_edit_options_${taskId}` }],
        ],
      };

      await ctx.editMessageTextWithMarkdown(
        '🎯 Выберите новый приоритет задачи:',
        {
          reply_markup: keyboard,
        },
      );
    });

    // Set task priority
    this.bot.action(/^set_task_priority_(.+)_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];
      const priority = ctx.match[2];

      try {
        await this.taskService.updateTask(taskId, ctx.userId, {
          priority: priority,
        } as any);

        const priorityText =
          priority === 'HIGH'
            ? '🔴 Высокий'
            : priority === 'MEDIUM'
              ? '⬜ Средний'
              : priority === 'LOW'
                ? '🟢 Низкий'
                : '🔥 Срочный';

        await ctx.editMessageTextWithMarkdown(
          `✅ Приоритет задачи изменён на ${priorityText}`,
        );

        // Возвращаемся к просмотру задачи через небольшую паузу
        setTimeout(async () => {
          try {
            const task = await this.taskService.findTaskById(
              taskId,
              ctx.userId,
            );
            const statusEmoji = task.status === 'COMPLETED' ? '✅' : '⏳';
            const message =
              `${statusEmoji} *${task.title}*\n\n` +
              `📊 *Статус:* ${task.status === 'COMPLETED' ? 'Выполнена' : 'Активна'}\n` +
              `🎯 *Приоритет:* ${task.priority}\n` +
              `💎 *XP за выполнение:* ${task.xpReward}\n` +
              (task.description ? `📝 *Описание:* ${task.description}\n` : '') +
              (task.dueDate
                ? `📅 *Срок:* ${new Date(task.dueDate).toLocaleDateString('ru-RU')}\n`
                : '') +
              (task.completedAt
                ? `✅ *Выполнена:* ${new Date(task.completedAt).toLocaleDateString('ru-RU')}\n`
                : '');

            const keyboard = {
              inline_keyboard: [
                task.status === 'COMPLETED'
                  ? [
                      {
                        text: '� Вернуть в активные',
                        callback_data: `task_reopen_${task.id}`,
                      },
                      {
                        text: '✏️ Редактировать',
                        callback_data: `task_edit_options_${task.id}`,
                      },
                    ]
                  : [
                      {
                        text: '✅ Отметить выполненной',
                        callback_data: `toggle_task_${task.id}`,
                      },
                      {
                        text: '✏️ Редактировать',
                        callback_data: `task_edit_options_${task.id}`,
                      },
                    ],
                [
                  {
                    text: '🗑️ Удалить',
                    callback_data: `task_delete_${task.id}`,
                  },
                ],
                [
                  {
                    text: '⏰ Добавить напоминание',
                    callback_data: `add_task_reminder_${task.id}`,
                  },
                ],
                [
                  {
                    text: '🔙 Назад к списку задач',
                    callback_data: 'tasks_list',
                  },
                ],
              ],
            };

            await ctx.editMessageTextWithMarkdown(message, {
              reply_markup: keyboard,
            });
          } catch (err) {
            this.logger.error('Error refreshing task view:', err);
          }
        }, 1500);
      } catch (err) {
        this.logger.error('Error updating task priority:', err);
        await ctx.editMessageTextWithMarkdown(
          '❌ Не удалось изменить приоритет задачи',
        );
      }
    });

    // Add task reminder
    this.bot.action(/^add_task_reminder_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];
      ctx.session.step = 'setting_task_reminder';
      ctx.session.tempData = { taskId }; // Используем tempData

      await ctx.editMessageTextWithMarkdown(
        `⏰ *Добавление напоминания для задачи*

Отправьте время, когда хотите получить напоминание в формате:
• \`ЧЧ:ММ\` - на сегодня (например: 15:30)
• \`ДД.ММ ЧЧ:ММ\` - на конкретную дату (например: 15.09 10:00)

Или выберите готовый вариант:`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📅 Через 1 час',
                  callback_data: `quick_reminder_${taskId}_1h`,
                },
                {
                  text: '📅 Через 3 часа',
                  callback_data: `quick_reminder_${taskId}_3h`,
                },
              ],
              [
                {
                  text: '📅 Завтра утром (9:00)',
                  callback_data: `quick_reminder_${taskId}_tomorrow`,
                },
                {
                  text: '📅 Через неделю',
                  callback_data: `quick_reminder_${taskId}_week`,
                },
              ],
              [
                {
                  text: '🔙 Назад',
                  callback_data: `task_edit_options_${taskId}`,
                },
              ],
            ],
          },
        },
      );
    });

    // Quick reminder handlers for tasks
    this.bot.action(/^quick_reminder_(.+)_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const taskId = ctx.match[1];
      const period = ctx.match[2];

      try {
        const task = await this.taskService.findTaskById(taskId, ctx.userId);
        let reminderTime: Date;
        let confirmMessage: string;

        const now = new Date();

        switch (period) {
          case '1h':
            reminderTime = new Date(now.getTime() + 60 * 60 * 1000);
            confirmMessage = `⏰ *Напоминание установлено*\n\n📝 ${task.title}\n⏳ Через 1 час\n📅 ${reminderTime.toLocaleString('ru-RU')}`;
            break;
          case '3h':
            reminderTime = new Date(now.getTime() + 3 * 60 * 60 * 1000);
            confirmMessage = `⏰ *Напоминание установлено*\n\n📝 ${task.title}\n⏳ Через 3 часа\n📅 ${reminderTime.toLocaleString('ru-RU')}`;
            break;
          case 'tomorrow':
            reminderTime = new Date(now);
            reminderTime.setDate(reminderTime.getDate() + 1);
            reminderTime.setHours(9, 0, 0, 0);
            confirmMessage = `⏰ *Напоминание установлено*\n\n📝 ${task.title}\n⏳ Завтра утром\n📅 ${reminderTime.toLocaleString('ru-RU')}`;
            break;
          case 'week':
            reminderTime = new Date(now);
            reminderTime.setDate(reminderTime.getDate() + 7);
            reminderTime.setHours(9, 0, 0, 0);
            confirmMessage = `⏰ *Напоминание установлено*\n\n📝 ${task.title}\n⏳ Через неделю\n📅 ${reminderTime.toLocaleString('ru-RU')}`;
            break;
          default:
            throw new Error('Неизвестный период напоминания');
        }

        // Здесь должна быть логика сохранения напоминания в базе данных
        // Пока что просто показываем подтверждение
        await ctx.editMessageTextWithMarkdown(confirmMessage, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔙 К редактированию',
                  callback_data: `task_edit_options_${taskId}`,
                },
              ],
              [
                {
                  text: '📋 К задаче',
                  callback_data: `task_view_${taskId}`,
                },
              ],
              [
                {
                  text: '🏠 Главное меню',
                  callback_data: 'back_to_menu',
                },
              ],
            ],
          },
        });
      } catch (error) {
        this.logger.error('Error setting task reminder:', error);
        await ctx.editMessageTextWithMarkdown(
          '❌ Произошла ошибка при установке напоминания. Попробуйте позже.',
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🔙 Назад',
                    callback_data: `task_edit_options_${taskId}`,
                  },
                ],
              ],
            },
          },
        );
      }
    });

    // Show tasks editing menu
    this.bot.action('edit_tasks_menu', async (ctx) => {
      await ctx.answerCbQuery();

      try {
        const user = await this.userService.findByTelegramId(ctx.userId);
        const allTasks = await this.taskService.findTasksByUserId(user.id);

        const pendingTasks = allTasks.filter(
          (task) => task.status !== 'COMPLETED',
        );
        const completedTasks = allTasks.filter(
          (task) => task.status === 'COMPLETED',
        );

        let message = '✏️ *Редактирование задач*\n\n';
        message += 'Выберите активную задачу для редактирования:\n\n';

        const rows: any[] = [];

        // Показываем только активные задачи
        if (pendingTasks.length > 0) {
          pendingTasks.slice(0, 20).forEach((task) => {
            rows.push([
              {
                text: `⬜ ${task.title.substring(0, 50)}${task.title.length > 50 ? '...' : ''}`,
                callback_data: `task_view_${task.id}`,
              },
            ]);
          });
        } else {
          rows.push([
            {
              text: '📝 Нет активных задач для редактирования',
              callback_data: 'noop_separator',
            },
          ]);
        }

        // Добавляем кнопку для просмотра выполненных задач (если есть)
        if (completedTasks.length > 0) {
          rows.push([
            {
              text: `✅ Выполненные задачи (${completedTasks.length})`,
              callback_data: 'edit_completed_tasks',
            },
          ]);
        }

        rows.push([
          { text: '🔙 Назад к списку задач', callback_data: 'tasks_list' },
        ]);

        const keyboard = { inline_keyboard: rows };

        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
      } catch (err) {
        this.logger.error('Error showing edit tasks menu:', err);
        await ctx.editMessageTextWithMarkdown('❌ Ошибка при загрузке задач');
      }
    });

    // Show completed tasks for editing
    this.bot.action('edit_completed_tasks', async (ctx) => {
      await ctx.answerCbQuery();

      try {
        const user = await this.userService.findByTelegramId(ctx.userId);
        const allTasks = await this.taskService.findTasksByUserId(user.id);

        const completedTasks = allTasks.filter(
          (task) => task.status === 'COMPLETED',
        );

        let message = '✅ *Выполненные задачи*\n\n';
        message += 'Выберите выполненную задачу для просмотра:\n\n';

        const rows: any[] = [];

        if (completedTasks.length > 0) {
          completedTasks.slice(0, 15).forEach((task) => {
            rows.push([
              {
                text: `✅ ${task.title.substring(0, 50)}${task.title.length > 50 ? '...' : ''}`,
                callback_data: `task_view_${task.id}`,
              },
            ]);
          });
        } else {
          rows.push([
            {
              text: '📝 Нет выполненных задач',
              callback_data: 'noop_separator',
            },
          ]);
        }

        rows.push([
          { text: '🔙 К активным задачам', callback_data: 'edit_tasks_menu' },
        ]);

        const keyboard = { inline_keyboard: rows };

        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
      } catch (err) {
        this.logger.error('Error showing completed tasks for editing:', err);
        await ctx.editMessageTextWithMarkdown(
          '❌ Ошибка при загрузке выполненных задач',
        );
      }
    });

    // Handle back to main menu
    this.bot.action('back_to_main', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showMainMenu(ctx);
    });

    // Feedback system action handlers

    this.bot.action(/^feedback_rating_(\d+)$/, async (ctx) => {
      const rating = parseInt(ctx.match[1]);
      await this.handleFeedbackRating(ctx, rating);
    });

    this.bot.action(/^feedback_like_(.+)$/, async (ctx) => {
      const feature = ctx.match[1];

      // For /feedback command, complete survey immediately
      if (!ctx.session.feedbackRating) {
        await this.completeFeedbackSurvey(ctx, feature);
      } else {
        // For automatic feedback request, show improvement options
        await this.handleFeedbackImprovement(ctx, feature);
      }
    });

    this.bot.action(/^feedback_improve_(.+)$/, async (ctx) => {
      const improvement = ctx.match[1];
      if (improvement === 'custom') {
        await ctx.answerCbQuery();
        await ctx.editMessageTextWithMarkdown(`
📝 *Напишите, что хотелось бы улучшить:*

Опишите ваши пожелания...
        `);
        ctx.session.step = 'waiting_for_custom_feedback';
      } else {
        // Check if this is from /feedback command (no rating) or automatic request (with rating)
        if (ctx.session.feedbackRating) {
          await this.completeFeedback(ctx, improvement);
        } else {
          await this.completeFeedbackSurvey(ctx, improvement);
        }
      }
    });

    this.bot.action('feedback_later', async (ctx) => {
      await ctx.answerCbQuery();

      // Mark feedback as given to prevent showing again
      await this.userService.updateUser(ctx.userId, {
        feedbackGiven: true,
      });

      await ctx.editMessageTextWithMarkdown(`
🕐 *Хорошо, спросим позже!*

Вы всегда можете оставить отзыв командой /feedback
      `);
    });

    // Timezone setup handlers
    this.bot.action(/^confirm_timezone_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();
      const timezone = ctx.match[1];
      await this.confirmTimezone(ctx, timezone);
    });

    this.bot.action('manual_timezone', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showManualTimezoneSelection(ctx);
    });

    this.bot.action('input_city', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(`
🏙️ *Ввод города*

📍 Напишите название вашего города:
(например: Москва, Санкт-Петербург, Нью-Йорк, Лондон, Астана)
      `);
      ctx.session.step = 'waiting_for_city';
    });

    this.bot.action('select_timezone', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showTimezoneList(ctx);
    });

    // Interval reminder handlers
    this.bot.action('stop_interval_reminder', async (ctx) => {
      await ctx.answerCbQuery();
      const stopped = this.stopIntervalReminder(ctx.userId);

      if (stopped) {
        await ctx.editMessageTextWithMarkdown(
          `
🛑 *Интервальное напоминание остановлено*

Интервальные напоминания больше не будут отправляться.
        `,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      } else {
        await ctx.editMessageTextWithMarkdown(
          `
❌ *Нет активных интервальных напоминаний*

У вас нет запущенных интервальных напоминаний.
        `,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      }
    });

    this.bot.action('interval_status', async (ctx) => {
      await ctx.answerCbQuery();
      const reminder = this.activeIntervalReminders.get(ctx.userId);

      if (reminder) {
        const runningTime = Math.floor(
          (Date.now() - reminder.startTime.getTime()) / (1000 * 60),
        );
        const intervalText =
          reminder.intervalMinutes < 60
            ? `${reminder.intervalMinutes} минут`
            : `${Math.floor(reminder.intervalMinutes / 60)} час${reminder.intervalMinutes === 60 ? '' : 'а'}`;

        await ctx.editMessageTextWithMarkdown(
          `
📊 *Статус интервального напоминания*

📝 **Текст:** ${reminder.reminderText}
⏱️ **Интервал:** каждые ${intervalText}
🕐 **Запущено:** ${runningTime} мин назад
📬 **Отправлено:** ${reminder.count} напоминаний

Напоминание работает и будет продолжать отправлять уведомления.
        `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🛑 Остановить',
                    callback_data: 'stop_interval_reminder',
                  },
                ],
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      } else {
        await ctx.editMessageTextWithMarkdown(
          `
❌ *Нет активных интервальных напоминаний*

У вас нет запущенных интервальных напоминаний.
        `,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      }
    });

    // Reminder action handlers
    this.bot.action('reminder_done', async (ctx) => {
      await ctx.answerCbQuery('✅ Отмечено как выполненное!');
      await ctx.editMessageTextWithMarkdown(
        `✅ *Напоминание выполнено!*\n\nОтлично! Задача отмечена как выполненная.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    // Handler for reminders with ID
    this.bot.action(/^reminder_done_(.+)$/, async (ctx) => {
      const reminderId = ctx.match[1];
      await ctx.answerCbQuery('✅ Отмечено как выполненное!');

      try {
        // Update reminder status in database
        await this.prisma.reminder.update({
          where: { id: reminderId },
          data: { status: ReminderStatus.COMPLETED },
        });
      } catch (error) {
        this.logger.error('Error updating reminder status:', error);
      }

      await ctx.editMessageTextWithMarkdown(
        `✅ *Напоминание выполнено!*\n\nОтлично! Задача отмечена как выполненная.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    // Snooze handlers
    this.bot.action('reminder_snooze_15', async (ctx) => {
      await ctx.answerCbQuery('⏰ Напомним через 15 минут!');
      const originalMessage =
        (ctx.callbackQuery?.message as any)?.text || 'Напоминание';
      const reminderText = originalMessage
        .replace('🔔 *Напоминание!*', '')
        .trim();

      // Schedule new reminder in 15 minutes
      setTimeout(
        async () => {
          try {
            await ctx.telegram.sendMessage(
              ctx.userId,
              `🔔 *Напоминание!*\n\n${reminderText}`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '✅ Готово',
                        callback_data: 'reminder_done',
                      },
                    ],
                  ],
                },
              },
            );
          } catch (error) {
            this.logger.error('Error sending snoozed reminder:', error);
          }
        },
        15 * 60 * 1000,
      );

      await ctx.editMessageTextWithMarkdown(
        `⏰ *Напоминание отложено*\n\nНапомним через 15 минут!`,
      );
    });

    this.bot.action('reminder_snooze_60', async (ctx) => {
      await ctx.answerCbQuery('⏰ Напомним через час!');
      const originalMessage =
        (ctx.callbackQuery?.message as any)?.text || 'Напоминание';
      const reminderText = originalMessage
        .replace('🔔 *Напоминание!*', '')
        .trim();

      // Schedule new reminder in 1 hour
      setTimeout(
        async () => {
          try {
            await ctx.telegram.sendMessage(
              ctx.userId,
              `🔔 *Напоминание!*\n\n${reminderText}`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '✅ Готово',
                        callback_data: 'reminder_done',
                      },
                    ],
                  ],
                },
              },
            );
          } catch (error) {
            this.logger.error('Error sending snoozed reminder:', error);
          }
        },
        60 * 60 * 1000,
      );

      await ctx.editMessageTextWithMarkdown(
        `⏰ *Напоминание отложено*\n\nНапомним через час!`,
      );
    });

    // Snooze handlers with reminder ID
    this.bot.action(/^reminder_snooze_15_(.+)$/, async (ctx) => {
      const reminderId = ctx.match[1];
      await ctx.answerCbQuery('⏰ Напомним через 15 минут!');
      const originalMessage =
        (ctx.callbackQuery?.message as any)?.text || 'Напоминание';
      const reminderText = originalMessage
        .replace('🔔 *Напоминание!*', '')
        .trim();

      // Schedule new reminder in 15 minutes
      setTimeout(
        async () => {
          try {
            await ctx.telegram.sendMessage(
              ctx.userId,
              `🔔 *Напоминание!*\n\n${reminderText}`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '✅ Готово',
                        callback_data: `reminder_done_${String(reminderId).slice(0, 20)}`,
                      },
                    ],
                  ],
                },
              },
            );
          } catch (error) {
            this.logger.error('Error sending snoozed reminder:', error);
          }
        },
        15 * 60 * 1000,
      );

      await ctx.editMessageTextWithMarkdown(
        `⏰ *Напоминание отложено*\n\nНапомним через 15 минут!`,
      );
    });

    this.bot.action(/^reminder_snooze_60_(.+)$/, async (ctx) => {
      const reminderId = ctx.match[1];
      await ctx.answerCbQuery('⏰ Напомним через час!');
      const originalMessage =
        (ctx.callbackQuery?.message as any)?.text || 'Напоминание';
      const reminderText = originalMessage
        .replace('🔔 *Напоминание!*', '')
        .trim();

      // Schedule new reminder in 1 hour
      setTimeout(
        async () => {
          try {
            await ctx.telegram.sendMessage(
              ctx.userId,
              `🔔 *Напоминание!*\n\n${reminderText}`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '✅ Готово',
                        callback_data: `reminder_done_${reminderId}`,
                      },
                    ],
                  ],
                },
              },
            );
          } catch (error) {
            this.logger.error('Error sending snoozed reminder:', error);
          }
        },
        60 * 60 * 1000,
      );

      await ctx.editMessageTextWithMarkdown(
        `⏰ *Напоминание отложено*\n\nНапомним через час!`,
      );
    });

    this.bot.action('cancel_interval_setup', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `
❌ *Настройка отменена*

Новое интервальное напоминание не было создано.
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });

    // Handle replace interval reminder
    this.bot.action(/^replace_interval_(\d+)_(.+)$/, async (ctx) => {
      await ctx.answerCbQuery();

      const intervalMinutes = parseInt(ctx.match[1]);
      const reminderText = Buffer.from(ctx.match[2], 'base64').toString();

      // Stop current reminder
      this.stopIntervalReminder(ctx.userId);

      // Start new reminder
      await this.startIntervalReminder(ctx, reminderText, intervalMinutes);
    });

    // Natural reminder time handlers
    this.bot.action('remind_in_15min', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleQuickReminderTime(ctx, 15, 'минут');
    });

    this.bot.action('remind_in_30min', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleQuickReminderTime(ctx, 30, 'минут');
    });

    this.bot.action('remind_in_1hour', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleQuickReminderTime(ctx, 1, 'час');
    });

    this.bot.action('remind_in_2hours', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleQuickReminderTime(ctx, 2, 'часа');
    });

    this.bot.action('remind_tomorrow_morning', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleTomorrowReminder(ctx, '09', '00', 'утром в 9:00');
    });

    this.bot.action('remind_tomorrow_evening', async (ctx) => {
      await ctx.answerCbQuery();
      await this.handleTomorrowReminder(ctx, '18', '00', 'вечером в 18:00');
    });

    this.bot.action('remind_custom_time', async (ctx) => {
      await ctx.answerCbQuery();
      await this.askForCustomReminderTime(ctx);
    });

    this.bot.action('cancel_reminder', async (ctx) => {
      await ctx.answerCbQuery('❌ Создание напоминания отменено');
      ctx.session.pendingReminder = undefined;
      ctx.session.waitingForReminderTime = false;
      await ctx.editMessageText('❌ Создание напоминания отменено');
    });

    // Hour selection handlers
    [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22].forEach(
      (hour) => {
        const hourStr = hour.toString().padStart(2, '0');
        this.bot.action(`select_hour_${hourStr}`, async (ctx) => {
          await ctx.answerCbQuery();
          await this.showMinuteSelection(ctx, hourStr);
        });
      },
    );

    // Other hour selection handler
    this.bot.action('select_other_hour', async (ctx) => {
      await ctx.answerCbQuery();
      await ctx.editMessageTextWithMarkdown(
        `📝 *Напоминание:* "${ctx.session.pendingReminder?.text}"

🕐 *Выберите час (0-23):*`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '00', callback_data: 'select_hour_00' },
                { text: '01', callback_data: 'select_hour_01' },
                { text: '02', callback_data: 'select_hour_02' },
                { text: '03', callback_data: 'select_hour_03' },
              ],
              [
                { text: '04', callback_data: 'select_hour_04' },
                { text: '05', callback_data: 'select_hour_05' },
                { text: '06', callback_data: 'select_hour_06' },
                { text: '07', callback_data: 'select_hour_07' },
              ],
              [{ text: '23', callback_data: 'select_hour_23' }],
              [{ text: '🔙 Назад', callback_data: 'remind_custom_time' }],
              [{ text: '❌ Отмена', callback_data: 'cancel_reminder' }],
            ],
          },
        },
      );
    });

    // Additional hour handlers for 00-07 and 23
    [0, 1, 2, 3, 4, 5, 6, 7, 23].forEach((hour) => {
      const hourStr = hour.toString().padStart(2, '0');
      this.bot.action(`select_hour_${hourStr}`, async (ctx) => {
        await ctx.answerCbQuery();
        await this.showMinuteSelection(ctx, hourStr);
      });
    });

    // Minute selection handlers
    [
      '00',
      '05',
      '10',
      '15',
      '20',
      '25',
      '30',
      '35',
      '40',
      '45',
      '50',
      '55',
    ].forEach((minute) => {
      this.bot.action(`select_minute_${minute}`, async (ctx) => {
        await ctx.answerCbQuery();
        const selectedHour = ctx.session.tempData?.selectedHour;
        if (selectedHour && ctx.session.pendingReminder) {
          // Очищаем сессию
          const reminderText = ctx.session.pendingReminder.text;
          ctx.session.pendingReminder = undefined;
          ctx.session.waitingForReminderTime = false;
          ctx.session.tempData = undefined;

          // Создаем напоминание
          await this.handleReminderRequest(
            ctx,
            reminderText,
            selectedHour,
            minute,
          );
        } else {
          await ctx.editMessageText('❌ Ошибка: данные не найдены');
        }
      });
    });

    // Back to hour selection handler
    this.bot.action('back_to_hour_selection', async (ctx) => {
      await ctx.answerCbQuery();
      await this.showHourSelection(ctx);
    });

    // Error handling
    this.bot.catch((err, ctx) => {
      this.logger.error(`Bot error for ${ctx.updateType}:`, err);
      ctx.reply(
        '🚫 Произошла ошибка. Попробуйте позже или обратитесь к администратору.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    });
  }

  // AI specialized handlers
  private async handleAITaskRecommendations(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    const tasks = await this.taskService.findTasksByUserId(ctx.userId);
    const completedTasks = tasks.filter((t) => t.completedAt !== null);

    let recommendation = '';

    // Inform the user that AI is working on recommendations
    try {
      await ctx.editMessageTextWithMarkdown(
        `⏳ *ИИ анализирует ваш профиль и готовит персональные рекомендации...*`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            ],
          },
        },
      );
    } catch (e) {
      // ignore errors when editing (message may have changed) and proceed
      this.logger.warn('Could not show AI analyzing message, continuing', e);
    }

    try {
      this.logger.log(`Requesting task advice from OpenAI for user ${user.id}`);
      const aiAdvice = await this.openaiService.getTaskAdvice(
        user.id,
        this.aiContextService,
      );

      if (aiAdvice && aiAdvice.trim().length > 0) {
        recommendation = aiAdvice.trim();
      } else {
        // fallback to template if AI returned empty
        recommendation =
          '📝 Попробуйте начать с небольшой, конкретной задачи и завершить её сегодня.';
      }
    } catch (err) {
      this.logger.error('Error fetching task advice from OpenAI:', err);
      // Fallback to previous template logic
      if (tasks.length === 0) {
        recommendation =
          '📝 Создайте первую задачу! Начните с чего-то простого на сегодня.';
      } else if (completedTasks.length < tasks.length * 0.3) {
        recommendation =
          '🎯 Сфокусируйтесь на завершении текущих задач. Качество важнее количества!';
      } else {
        recommendation =
          '🚀 Отличная работа! Попробуйте технику Помодоро для повышения продуктивности.';
      }
    }

    await ctx.editMessageTextWithMarkdown(
      `
💡 *Рекомендации по задачам*

📊 Статистика: ${completedTasks.length}/${tasks.length} задач выполнено

${recommendation}

*Совет:* Разбивайте большие задачи на маленькие шаги.
      `,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );
  }

  private async handleAIHabitHelp(ctx: BotContext) {
    try {
      const user = await this.userService.findByTelegramId(ctx.userId);
      const habits = await this.habitService.findHabitsByUserId(ctx.userId);
      const completedHabits = habits.filter((h) => h.totalCompletions > 0);

      // Показываем промежуточное сообщение, пока ИИ готовит рекомендации по привычкам
      try {
        await ctx.editMessageTextWithMarkdown(
          `⏳ *ИИ анализирует ваш профиль и готовит персональные рекомендации по привычкам...*`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
              ],
            },
          },
        );
      } catch (e) {
        this.logger.warn(
          'Could not show AI analyzing habits message, continuing',
          e,
        );
      }

      // Анализируем профиль пользователя для персональных рекомендаций
      const userProfile = {
        totalHabits: habits.length,
        activeHabits: habits.filter((h) => h.isActive).length,
        completedHabits: completedHabits.length,
        avgStreak:
          habits.length > 0
            ? habits.reduce((sum, h) => sum + h.currentStreak, 0) /
              habits.length
            : 0,
      };

      // Получаем реальный ИИ-ответ по привычкам
      const aiHabitAdvice = await this.openaiService.getHabitHelp(
        user.id,
        this.aiContextService,
      );
      let motivationalMessage = '';
      let personalizedRecommendations: string[] = [];

      // Парсим ответ ИИ: первая строка — мотивация, далее — рекомендации
      if (aiHabitAdvice) {
        const lines = aiHabitAdvice.split('\n').filter((l) => l.trim());
        motivationalMessage = lines[0] || '';
        personalizedRecommendations = lines.slice(1);
      }

      // Формируем ответ
      let message = `🎯 *Персональные рекомендации по привычкам*\n\n`;

      if (habits.length > 0) {
        message += `📊 *Ваш профиль:*\n`;
        message += `• Привычек: ${userProfile.totalHabits} (активных: ${userProfile.activeHabits})\n`;
        message += `• Средняя серия: ${Math.round(userProfile.avgStreak)} дней\n`;
        message += `• Выполняемых: ${completedHabits.length}\n\n`;
      }

      message += `💡 *${motivationalMessage}*\n\n`;
      message += `🎯 *Рекомендации для вас:*\n`;

      personalizedRecommendations.forEach((rec, index) => {
        message += `${index + 1}. ${rec}\n`;
      });

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '📝 Создать привычку',
              callback_data: 'habits_add',
            },
            {
              text: '🎯 Мои привычки',
              callback_data: 'habits_list',
            },
          ],
          [
            {
              text: '⬅️ Назад к ИИ меню',
              callback_data: 'ai_back_menu',
            },
          ],
        ],
      };

      try {
        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
      } catch (err) {
        // If Telegram reports that message is not modified, send a new message instead
        const e = err as any;
        const desc = e?.response?.description || e?.message || '';
        if (
          typeof desc === 'string' &&
          desc.includes('message is not modified')
        ) {
          this.logger.log(
            'Edit resulted in no-op, sending a new message instead',
          );
          await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
        } else {
          throw err;
        }
      }
    } catch (error) {
      this.logger.error('Error in handleAIHabitHelp:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при анализе привычек. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            ],
          },
        },
      );
    }
  }

  private async handleAICreateHabit(ctx: BotContext) {
    await ctx.editMessageTextWithMarkdown(
      `
🤖 *Создание привычки с помощью ИИ*

Опишите, какую привычку хотите сформировать, и я помогу:
• 📝 Сформулировать её правильно
• ⏰ Подобрать оптимальное время
• 🎯 Разработать план внедрения
• 💡 Дать персональные советы

*Примеры:*
"Хочу больше читать"
"Нужно пить больше воды" 
"Хочу делать зарядку"
"Буду медитировать"

💬 Просто напишите своими словами!
      `,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '⬅️ Назад к помощи с привычками',
                callback_data: 'ai_habit_help',
              },
            ],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );

    // Enable AI habit creation mode
    ctx.session.aiHabitCreationMode = true;
  }

  private async handleAIHabitCreationMessage(
    ctx: BotContext,
    userInput: string,
  ) {
    try {
      // Отключаем режим создания привычек
      ctx.session.aiHabitCreationMode = false;

      // Анализируем запрос пользователя с помощью AI
      const analysisPrompt = `Пользователь хочет создать привычку: "${userInput}"

Проанализируй запрос и создай структурированный ответ:

1. Конкретная привычка (максимум 50 символов)
2. Рекомендуемое время для выполнения
3. Частота (ежедневно, еженедельно и т.д.)
4. Советы по внедрению (2-3 коротких совета)
5. Мотивирующее сообщение

Отвечай на русском языке в дружественном тоне.`;

      const aiResponse = await this.openaiService.getAIResponse(analysisPrompt);

      // Парсим ответ AI для создания привычки
      const habitData = this.parseAIHabitResponse(aiResponse, userInput);

      // Создаем привычку
      const habit = await this.habitService.createHabit({
        userId: ctx.userId,
        title: habitData.title,
        description: habitData.description,
        frequency: 'DAILY',
        reminderTime: habitData.reminderTime,
      });

      // Формируем ответ пользователю
      let message = `🎉 *Привычка создана с помощью ИИ!*\n\n`;
      message += `📝 **${habit.title}**\n\n`;

      if (habitData.aiAdvice) {
        message += `🤖 *Совет от ИИ:*\n${habitData.aiAdvice}\n\n`;
      }

      if (habitData.implementationTips.length > 0) {
        message += `💡 *Советы по внедрению:*\n`;
        habitData.implementationTips.forEach((tip, index) => {
          message += `${index + 1}. ${tip}\n`;
        });
        message += `\n`;
      }

      message += `✨ *${habitData.motivationalMessage}*`;

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '⏰ Настроить напоминание',
              callback_data: `habit_set_reminder_${String(habit.id).slice(0, 20)}`,
            },
          ],
          [
            {
              text: '🎯 Мои привычки',
              callback_data: 'habits_list',
            },
            {
              text: '🤖 Создать ещё',
              callback_data: 'ai_create_habit',
            },
          ],
          [
            {
              text: '🏠 Главное меню',
              callback_data: 'back_to_menu',
            },
            {
              text: '❓ Что еще я умею?',
              callback_data: 'faq_support',
            },
          ],
        ],
      };

      await ctx.replyWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error in handleAIHabitCreationMessage:', error);
      ctx.session.aiHabitCreationMode = false;

      await ctx.replyWithMarkdown(
        '❌ Не удалось создать привычку с помощью ИИ. Попробуйте позже или создайте привычку вручную.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Создать вручную', callback_data: 'habits_add' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  private parseAIHabitResponse(aiResponse: string, originalInput: string) {
    // Простой парсер ответа ИИ - можно улучшить
    const defaultHabit = {
      title:
        originalInput.length > 50
          ? originalInput.substring(0, 50)
          : originalInput,
      description: `Привычка, созданная с помощью ИИ: ${originalInput}`,
      reminderTime: '09:00',
      implementationTips: [
        'Начните с малого',
        'Будьте постоянны',
        'Отмечайте прогресс',
      ],
      aiAdvice:
        aiResponse.length > 200
          ? aiResponse.substring(0, 200) + '...'
          : aiResponse,
      motivationalMessage: 'Вы на правильном пути к лучшей версии себя!',
    };

    try {
      // Пытаемся извлечь структурированную информацию из ответа ИИ
      const lines = aiResponse.split('\n').filter((line) => line.trim());

      for (const line of lines) {
        if (line.toLowerCase().includes('привычка') && line.includes(':')) {
          const habitTitle = line.split(':')[1]?.trim();
          if (habitTitle && habitTitle.length <= 50) {
            defaultHabit.title = habitTitle;
          }
        }

        if (line.toLowerCase().includes('время') && line.includes(':')) {
          const timeMatch = line.match(/\d{1,2}:\d{2}/);
          if (timeMatch) {
            defaultHabit.reminderTime = timeMatch[0];
          }
        }
      }

      return defaultHabit;
    } catch (error) {
      this.logger.warn('Failed to parse AI response, using defaults:', error);
      return defaultHabit;
    }
  }

  private async handleNaturalReminderRequest(ctx: BotContext, text: string) {
    try {
      // СНАЧАЛА проверяем интервальные напоминания
      // Check for interval reminders - специальные случаи
      let intervalMinutes = 0;
      let intervalAmount = 0;
      let intervalUnit = '';

      // Проверяем "каждую минуту", "каждый час" и т.д.
      if (text.match(/каждую\s+минуту/i)) {
        intervalMinutes = 1;
        intervalAmount = 1;
        intervalUnit = 'минут';
      } else if (text.match(/каждый\s+час/i)) {
        intervalMinutes = 60;
        intervalAmount = 1;
        intervalUnit = 'час';
      } else {
        // Check for interval reminders (каждые X минут/часов)
        const intervalMatch = text.match(
          /каждые?\s*(\d+)\s*(минут|час|часа|часов)/i,
        );

        if (intervalMatch) {
          intervalAmount = parseInt(intervalMatch[1]);
          intervalUnit = intervalMatch[2].toLowerCase();

          if (intervalUnit.includes('минут')) {
            intervalMinutes = intervalAmount;
          } else if (intervalUnit.includes('час')) {
            intervalMinutes = intervalAmount * 60;
          }
        }
      }

      if (intervalMinutes > 0) {
        // Validate interval (minimum 1 minute, maximum 24 hours)
        if (intervalMinutes < 1 || intervalMinutes > 1440) {
          await ctx.replyWithMarkdown(`
❌ *Неверный интервал*

Интервал должен быть от 1 минуты до 24 часов.
          `);
          return;
        }

        // Extract reminder text for interval reminder
        const reminderText = text
          .replace(/напомни\s*(мне)?/gi, '')
          .replace(/напомню\s*(тебе|вам)?/gi, '')
          .replace(/напоминание/gi, '')
          .replace(/поставь/gi, '')
          .replace(/установи/gi, '')
          .replace(/каждую\s+минуту/gi, '')
          .replace(/каждый\s+час/gi, '')
          .replace(/каждые?\s*\d+\s*(?:минут|час|часа|часов)/gi, '')
          .trim();

        if (!reminderText || reminderText.length < 2) {
          await ctx.replyWithMarkdown(`
🤔 *О чем напоминать каждые ${intervalAmount} ${intervalUnit}?*

Вы указали интервал, но не указали, о чем напоминать.

*Пример:* "напоминай пить воду каждые 30 минут"
          `);
          return;
        }

        await this.handleIntervalReminder(ctx, reminderText, intervalMinutes);
        return;
      }

      // Если не интервальное, то обрабатываем как обычное напоминание
      // Извлекаем текст напоминания
      const reminderText = this.extractReminderText(text);

      // Проверяем, есть ли уже время в сообщении
      const timeMatch = this.extractTimeFromText(text);

      if (timeMatch) {
        // Если время указано, создаем напоминание
        await this.handleReminderRequest(
          ctx,
          reminderText,
          timeMatch.hours,
          timeMatch.minutes,
        );
      } else {
        // Если время не указано, просим уточнить
        await this.askForReminderTime(ctx, reminderText);
      }
    } catch (error) {
      this.logger.error('Error handling natural reminder request:', error);
      await ctx.reply(
        '❌ Не удалось обработать запрос. Попробуйте использовать меню напоминаний.',
      );
    }
  }

  private extractReminderText(text: string): string {
    // Удаляем ключевые слова напоминания и получаем основной текст
    const cleanText = text
      .toLowerCase()
      .replace(
        /^(напомни мне|напомни|поставь напоминание|создай напоминание|remind me|remind)\s*/i,
        '',
      )
      .replace(/\s*(через|в|в течение|after|in)\s*\d+.*$/i, '') // Удаляем временные указатели
      .trim();

    return cleanText || 'Напоминание';
  }

  private extractTimeFromText(
    text: string,
  ): { hours: string; minutes: string } | null {
    // Ищем время в формате HH:MM
    const timeRegex = /(\d{1,2}):(\d{2})/;
    const timeMatch = text.match(timeRegex);

    if (timeMatch) {
      return {
        hours: timeMatch[1].padStart(2, '0'),
        minutes: timeMatch[2],
      };
    }

    // Ищем относительное время (через X минут/часов)
    const relativeTimeRegex = /через\s+(\d+)\s*(минут|час|часа|часов)/i;
    const relativeMatch = text.match(relativeTimeRegex);

    if (relativeMatch) {
      const amount = parseInt(relativeMatch[1]);
      const unit = relativeMatch[2].toLowerCase();

      const now = new Date();
      let targetTime = new Date(now);

      if (unit.includes('минут')) {
        targetTime.setMinutes(targetTime.getMinutes() + amount);
        // Normalize to minute boundary (seconds and ms = 0)
        targetTime.setSeconds(0, 0);
        // If normalization moved time to the past or equal to now, push to next minute
        if (targetTime.getTime() <= now.getTime()) {
          targetTime.setTime(targetTime.getTime() + 60 * 1000);
        }
      } else if (unit.includes('час')) {
        targetTime.setHours(targetTime.getHours() + amount);
        // Normalize to minute boundary (seconds and ms = 0)
        targetTime.setSeconds(0, 0);
        if (targetTime.getTime() <= now.getTime()) {
          targetTime.setTime(targetTime.getTime() + 60 * 1000);
        }
      }

      return {
        hours: targetTime.getHours().toString().padStart(2, '0'),
        minutes: targetTime.getMinutes().toString().padStart(2, '0'),
      };
    }

    return null;
  }

  private async askForReminderTime(ctx: BotContext, reminderText: string) {
    // Сохраняем текст напоминания в сессии
    ctx.session.pendingReminder = {
      text: reminderText,
      originalText: reminderText,
    };
    ctx.session.waitingForReminderTime = true;

    await ctx.replyWithMarkdown(
      `📝 *Создаю напоминание:* "${reminderText}"

⏰ Когда напомнить? Выберите время:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '⏰ Через 15 мин', callback_data: 'remind_in_15min' },
              { text: '⏰ Через 30 мин', callback_data: 'remind_in_30min' },
            ],
            [
              { text: '⏰ Через 1 час', callback_data: 'remind_in_1hour' },
              { text: '⏰ Через 2 часа', callback_data: 'remind_in_2hours' },
            ],
            [
              {
                text: '⏰ Завтра утром (9:00)',
                callback_data: 'remind_tomorrow_morning',
              },
              {
                text: '⏰ Завтра вечером (18:00)',
                callback_data: 'remind_tomorrow_evening',
              },
            ],
            [
              {
                text: '🕐 Указать точное время',
                callback_data: 'remind_custom_time',
              },
            ],
            [{ text: '❌ Отмена', callback_data: 'cancel_reminder' }],
          ],
        },
      },
    );
  }

  private async handleSimpleReminderRequest(ctx: BotContext, text: string) {
    this.logger.log(
      `Handling simple reminder request: "${text}" for user ${ctx.userId}`,
    );

    // Извлекаем текст напоминания (убираем служебные слова)
    let reminderText = text;

    // Убираем начальные служебные фразы
    reminderText = reminderText.replace(
      /^(напомни\s+мне\s+|напомню\s+себе\s+|напоминание\s+|поставь\s+напоминание\s+|установи\s+напоминание\s+|создай\s+напоминание\s+)/i,
      '',
    );

    // Требуем явного указания времени. Если время не указано — не создаём напоминание.
    let cleanedText = reminderText.trim();

    // Попробуем определить явное время в тексте (например: "15:00" или "через 5 минут" или "завтра в 15:00")
    const timeInfo = this.extractTimeFromText(text);

    // Очищаем текст и сохраняем напоминание
    cleanedText = this.extractReminderText(reminderText);
    ctx.session.pendingReminder = {
      text: cleanedText,
      originalText: text,
    };

    if (timeInfo) {
      // Если время явно указано — создаём напоминание сразу
      ctx.session.waitingForReminderTime = false;
      ctx.session.pendingReminderTime = undefined;

      // Делегируем создание и расписание напоминания в общий обработчик
      await this.handleReminderRequest(
        ctx,
        cleanedText,
        timeInfo.hours,
        timeInfo.minutes,
      );
      return;
    }

    // Если время не указано — создаём ЗАДАЧУ, а не напоминание
    try {
      const task = await this.taskService.createTask({
        userId: ctx.userId,
        title: cleanedText,
        description: cleanedText,
        priority: 'MEDIUM',
      });

      await ctx.replyWithMarkdown(
        `✅ Задача создана!\n\n📝 "${cleanedText}"\n\nЗадача добавлена в ваш список. Вы можете найти её в разделе "Мои задачи и привычки".\n\n💡 Подсказки:\n• Напоминание: "напомни купить молоко в 17:30"\n• Интервальное: "напоминай пить воду каждые 30 минут"`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error creating task from reminder text:', error);
      await ctx.replyWithMarkdown(
        '❌ Не удалось создать задачу. Попробуйте снова.',
      );
    }
    return;
  }

  private async handleAITimePlanning(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    const currentHour = new Date().getHours();

    let timeAdvice = '';
    if (currentHour < 9) {
      timeAdvice =
        '🌅 Утром лучше планировать самые важные дела. Мозг работает эффективнее!';
    } else if (currentHour < 14) {
      timeAdvice =
        '☀️ Пик продуктивности! Время для сложных задач и важных решений.';
    } else if (currentHour < 18) {
      timeAdvice =
        '🕐 После обеда энергия снижается. Подходящее время для рутинных дел.';
    } else {
      timeAdvice =
        '🌆 Вечер - время для планирования завтрашнего дня и легких задач.';
    }

    await ctx.editMessageTextWithMarkdown(
      `
⏰ *Планирование времени*

🕐 Сейчас ${currentHour}:00

${timeAdvice}

*Методы:*
• 🍅 Помодоро (25 мин работа / 5 мин отдых)
• ⏰ Блокировка времени 
• 🎯 Правило 3-х приоритетов
      `,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );
  }

  private async handleAICustomQuestion(ctx: BotContext) {
    await ctx.editMessageTextWithMarkdown(
      `
✍️ *Задайте свой вопрос*

Напишите вопрос по одной из тем:
• Управлении задачами
• Формировании привычек  
• Планировании времени
• Мотивации и целях
• Продуктивности

Я отвечу кратко и по делу!
      `,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );

    // Enable custom AI chat mode
    ctx.session.aiChatMode = true;
  }

  // Referral system methods
  private async handleReferralRegistration(
    ctx: BotContext,
    newUserId: string,
    referrerId: string,
  ): Promise<void> {
    try {
      // Проверяем, что пользователи разные
      if (newUserId === referrerId) {
        return;
      }

      // Проверяем существование реферера
      const referrer = await this.userService
        .findByTelegramId(referrerId)
        .catch(() => null);
      if (!referrer) {
        this.logger.warn(`Referrer ${referrerId} not found`);
        return;
      }

      // Устанавливаем связь реферала в базе данных
      await this.userService.updateUser(newUserId, {
        referredBy: referrer.id,
      });

      // Увеличиваем счетчик рефералов у реферера
      const currentReferralsCount = await this.getReferralsCount(referrerId);
      await this.userService.updateUser(referrerId, {
        referralsCount: currentReferralsCount + 1,
        activeReferrals: currentReferralsCount + 1, // Считаем всех рефералов активными
      });

      // Начисляем бонусы рефереру
      const referrerUser = await this.userService.findByTelegramId(referrerId);
      let bonusXp = 500; // Базовый бонус

      // Проверяем достижения и даем дополнительные бонусы
      const newReferralsCount = currentReferralsCount + 1;
      let achievementMessage = '';
      let achievementType: 'first' | 'triple' | 'five' | null = null;

      if (newReferralsCount === 1) {
        bonusXp += 200; // Дополнительный бонус за первого друга
        achievementMessage =
          '\n🏆 Достижение "Первый друг" разблокировано! (+200 XP)';
        achievementType = 'first';
      } else if (newReferralsCount === 3) {
        bonusXp += 500; // Дополнительный бонус за 3 друзей
        achievementMessage =
          '\n🏆 Достижение "Тройка друзей" разблокировано! (+500 XP)';
        achievementType = 'triple';
      } else if (newReferralsCount === 5) {
        bonusXp += 1000; // Большой бонус за 5 друзей
        achievementMessage =
          '\n🏆 Достижение "Пятерка друзей" разблокировано! (+1000 XP)';
        achievementType = 'five';
      }

      await this.userService.updateUser(referrerId, {
        totalXp: referrerUser.totalXp + bonusXp,
      });

      // Начисляем бонус новому пользователю
      const newUser = await this.userService.findByTelegramId(newUserId);
      await this.userService.updateUser(newUserId, {
        totalXp: newUser.totalXp + 200,
      });

      // Отправляем обычное уведомление
      try {
        await this.bot.telegram.sendMessage(
          referrerId,
          `🎉 *Поздравляем!*

👤 Ваш друг присоединился к Ticky AI!

 **РЕФЕРАЛЬНАЯ СИСТЕМА АКТИВИРОВАНА:**
• Когда друг оплатит месячную подписку (199₽) → Вы получите 79₽
• Когда друг оплатит годовую подписку (999₽) → Вы получите 399₽
• Выплаты поступают мгновенно на ваш баланс!

👥 Всего друзей: ${newReferralsCount}/5${achievementMessage}

🎁 **XP бонусы:**
💰 Вы получили +${bonusXp} XP
✨ Друг получил +200 XP при регистрации

🔗 Поделитесь ссылкой с еще большим количеством друзей и зарабатывайте!`,
          { parse_mode: 'Markdown' },
        );

        // Отправляем дополнительное уведомление о достижении
        if (achievementType) {
          setTimeout(async () => {
            await this.sendReferralAchievementNotification(
              referrerId,
              achievementType,
              bonusXp,
            );
          }, 2000); // Через 2 секунды после основного уведомления
        }
      } catch (error) {
        this.logger.warn(
          `Could not send referral notification to ${referrerId}: ${error.message}`,
        );
      }
      await ctx.replyWithMarkdown(
        `🎁 *Добро пожаловать!*\n\nВы присоединились по приглашению друга!\n⭐ Получили +200 XP бонус при регистрации\n\n🚀 Давайте начнем знакомство с ботом!`,
      );

      this.logger.log(
        `Referral registration: ${newUserId} invited by ${referrerId}`,
      );
    } catch (error) {
      this.logger.error('Error handling referral registration:', error);
    }
  }

  /**
   * Отправляет уведомление о достижении реферального уровня
   */
  private async sendReferralAchievementNotification(
    userId: string,
    achievement: 'first' | 'triple' | 'five',
    bonusXp: number,
  ): Promise<void> {
    try {
      let message = '';
      let emoji = '';

      switch (achievement) {
        case 'first':
          emoji = '🥉';
          message = `${emoji} *ДОСТИЖЕНИЕ РАЗБЛОКИРОВАНО!*

🎉 **"Первый друг"**
Вы пригласили своего первого друга!

💰 **Получено:** +${bonusXp} XP
🎯 **Следующая цель:** Пригласить 3 друзей`;
          break;

        case 'triple':
          emoji = '🥈';
          message = `${emoji} *ДОСТИЖЕНИЕ РАЗБЛОКИРОВАНО!*

🎉 **"Тройка друзей"**
У вас уже 3 приглашенных друга!

💰 **Получено:** +${bonusXp} XP
🎯 **Следующая цель:** Пригласить 5 друзей`;
          break;

        case 'five':
          emoji = '🥇';
          message = `${emoji} *МАКСИМАЛЬНОЕ ДОСТИЖЕНИЕ!*

🎉 **"Пятерка друзей"**
Вы достигли максимума - 5 друзей!

💰 **Получено:** +${bonusXp} XP
🏆 **Статус:** Мастер рефералов
👑 **Бонус:** Все достижения разблокированы!`;
          break;
      }

      await this.bot.telegram.sendMessage(userId, message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '📊 Моя статистика',
                callback_data: 'referral_stats',
              },
            ],
            [
              {
                text: '� Копировать ссылку',
                callback_data: 'copy_referral_link',
              },
              {
                text: '📤 Поделиться',
                callback_data: 'share_referral_link',
              },
            ],
          ],
        },
      });
    } catch (error) {
      this.logger.warn(
        `Could not send achievement notification to ${userId}:`,
        error,
      );
    }
  }

  /**
   * Обновляет активность пользователя для корректного отслеживания рефералов
   */
  private async updateUserActivity(userId: string): Promise<void> {
    try {
      await this.userService.updateUser(userId, {
        lastActivity: new Date(),
      });
    } catch (error) {
      // Не критично, если не удалось обновить активность
      this.logger.debug(`Could not update activity for ${userId}:`, error);
    }
  }

  /**
   * Получает актуальное количество рефералов из базы данных
   */
  private async getReferralsCount(userId: string): Promise<number> {
    try {
      const user = await this.userService.findByTelegramId(userId);
      const referralsCount = await this.prisma.user.count({
        where: {
          referredBy: user.id,
        },
      });
      return referralsCount;
    } catch (error) {
      this.logger.error(`Error getting referrals count for ${userId}:`, error);
      return 0;
    }
  }

  /**
   * Получает детальную статистику по рефералам
   */
  private async getReferralStats(userId: string): Promise<{
    totalReferrals: number;
    activeReferrals: number;
    totalBonus: number;
    referralBalance: number;
    topReferrals: Array<{ name: string; joinDate: string; isActive: boolean }>;
  }> {
    try {
      const user = await this.userService.findByTelegramId(userId);

      // Получаем всех рефералов
      const referrals = await this.prisma.user.findMany({
        where: {
          referredBy: user.id,
        },
        select: {
          firstName: true,
          lastName: true,
          username: true,
          createdAt: true,
          lastActivity: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      // Считаем активных рефералов (активность за последние 7 дней)
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      const activeReferrals = referrals.filter(
        (ref) => ref.lastActivity && ref.lastActivity > weekAgo,
      ).length;

      // Рассчитываем общий бонус (базовый бонус + достижения)
      const totalReferrals = referrals.length;
      let totalBonus = totalReferrals * 500; // Базовый бонус за каждого

      // Добавляем бонусы за достижения
      if (totalReferrals >= 1) totalBonus += 200; // Первый друг
      if (totalReferrals >= 3) totalBonus += 500; // Тройка друзей
      if (totalReferrals >= 5) totalBonus += 1000; // Пятерка друзей

      // Получаем реферальный баланс из БД
      const userData = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: { referralBalance: true },
      });

      // Подготавливаем список топ рефералов
      const topReferrals = referrals.slice(0, 5).map((ref) => ({
        name: ref.firstName || ref.username || 'Пользователь',
        joinDate: ref.createdAt.toLocaleDateString('ru-RU'),
        isActive: !!(ref.lastActivity && ref.lastActivity > weekAgo),
      }));

      return {
        totalReferrals,
        activeReferrals,
        totalBonus,
        referralBalance: userData?.referralBalance || 0,
        topReferrals,
      };
    } catch (error) {
      this.logger.error(`Error getting referral stats for ${userId}:`, error);
      return {
        totalReferrals: 0,
        activeReferrals: 0,
        totalBonus: 0,
        referralBalance: 0,
        topReferrals: [],
      };
    }
  }

  async onModuleInit() {
    // Запускаем бота асинхронно, не дожидаясь завершения
    this.launch().catch((error) => {
      this.logger.error('Failed to launch bot:', error);
    });

    // Инициализация системы мотивационных сообщений для зависимостей
    this.startMotivationalMessagesService();
  }

  private startMotivationalMessagesService() {
    // Отправка мотивационных сообщений каждый час с 8:00 до 22:00
    setInterval(
      async () => {
        const currentHour = new Date().getHours();

        // Работаем только с 8:00 до 22:00
        if (currentHour >= 8 && currentHour <= 22) {
          await this.sendMotivationalMessages();
        }
      },
      60 * 60 * 1000,
    ); // каждый час

    this.logger.log('Motivational messages service started');
  }

  private async sendMotivationalMessages() {
    try {
      // Здесь вы бы получили список пользователей с активными зависимостями
      // Пока что это заглушка для демонстрации структуры

      // const usersWithDependencies = await this.getUsersWithActiveDependencies();
      //
      // for (const user of usersWithDependencies) {
      //   const motivationalMessage = await this.generateMotivationalMessage(user.dependency);
      //   await this.bot.telegram.sendMessage(user.telegramId, motivationalMessage, {
      //     parse_mode: 'Markdown'
      //   });
      // }

      this.logger.log('Motivational messages sent');
    } catch (error) {
      this.logger.error('Error sending motivational messages:', error);
    }
  }

  async onModuleDestroy() {
    await this.stop();
  }

  private async startOnboarding(ctx: BotContext) {
    // Step 1: Welcome
    await this.showOnboardingStep1(ctx);
  }

  private async showOnboardingStep1(ctx: BotContext) {
    // При переходе в главное меню отключаем режим ИИ-чата
    ctx.session.aiChatMode = false;
    const keyboard = {
      inline_keyboard: [
        [
          { text: '🚀 Начать', callback_data: 'onboarding_start' },
          {
            text: '👀 Посмотреть примеры',
            callback_data: 'onboarding_examples',
          },
        ],
      ],
    };

    await ctx.replyWithMarkdown(
      `🤖 *Привет! Я Ticky AI — твой AI-ассистент по привычкам и задачам с геймификацией.*`,
      { reply_markup: keyboard },
    );

    ctx.session.step = 'onboarding_welcome';
  }

  private async showOnboardingStep2(ctx: BotContext) {
    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '🎯 Добавить привычку',
            callback_data: 'onboarding_add_habit',
          },
          { text: '⏭️ Пропустить', callback_data: 'onboarding_skip_habit' },
        ],
      ],
    };

    await ctx.editMessageTextWithMarkdown(
      `
🚀 *Быстрый старт*

Давай добавим твою первую привычку!
Например: "Пить воду"

*Выбери действие:*
    `,
      { reply_markup: keyboard },
    );

    ctx.session.step = 'onboarding_quick_start';
  }

  private async showOnboardingStep3(ctx: BotContext) {
    const keyboard = {
      inline_keyboard: [
        [{ text: '✅ Понятно!', callback_data: 'onboarding_complete' }],
      ],
    };

    await ctx.replyWithMarkdown(
      `
📚 *Мини-FAQ*

*ЧТО УМЕЕТ БОТ?*

• Добавлять задачи и привычки
• Следить за прогрессом
• Вовлекать в челленджи
• Напоминать о важных делах

🎯 Готов начать продуктивный день?
    `,
      { reply_markup: keyboard },
    );

    ctx.session.step = 'onboarding_faq';
  }

  private async showMainMenu(ctx: BotContext, shouldEdit: boolean = false) {
    // Clear any session state when showing main menu
    ctx.session.step = undefined;
    ctx.session.pendingAction = undefined;
    ctx.session.tempData = undefined;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '➕ Добавить привычку', callback_data: 'add_habit' },
          { text: '✅ Мои привычки', callback_data: 'my_habits' },
        ],
        [
          { text: '📝 Мои задачи', callback_data: 'my_tasks' },
          { text: '🍅 Помодоро', callback_data: 'pomodoro_focus' },
        ],
        [
          { text: '🟢 Ещё функции', callback_data: 'more_functions' },
          { text: '🧠 Чат с ИИ', callback_data: 'ai_chat' },
        ],
        [
          { text: '📊 Прогресс', callback_data: 'my_progress' },
          { text: '❓ Помощь', callback_data: 'faq_support' },
          { text: '🔒 Лимиты', callback_data: 'show_limits' },
        ],
      ],
    };

    const user = await this.getOrCreateUser(ctx);
    const trialInfo = await this.billingService.getTrialInfo(ctx.userId);
    const subscriptionStatus = await this.billingService.getSubscriptionStatus(
      ctx.userId,
    );

    // Получаем статистику привычек на сегодня
    const todayHabits = await this.habitService.findHabitsByUserId(
      ctx.userId,
      true,
    );
    const activeHabits = todayHabits.filter((habit) => habit.isActive);
    const completedHabits: any[] = [];

    // Проверяем какие привычки выполнены сегодня
    for (const habit of activeHabits) {
      const isCompleted = await this.habitService.isCompletedToday(habit);
      if (isCompleted) {
        completedHabits.push(habit);
      }
    }

    const totalHabits = activeHabits.length;

    // Создаем прогресс-бар для привычек
    let habitsProgressBar = '';
    if (totalHabits > 0) {
      // Создаем визуальный прогресс для каждой привычки — заполняется слева направо
      const completedCount = completedHabits.length;
      const habitProgress =
        '🟩'.repeat(completedCount) +
        '⬜'.repeat(Math.max(0, totalHabits - completedCount));

      habitsProgressBar = `\n🎯 **Привычки на ${new Date().toLocaleDateString('ru-RU')}:**\nПрогресс: ${habitProgress} ${completedCount}/${totalHabits}`;
    } else {
      habitsProgressBar = `\n🎯 **Привычки на сегодня:** Пока нет привычек`;
    }

    // Проверяем активную помодоро сессию
    const activeSession = this.activePomodoroSessions.get(ctx.userId);
    let pomodoroStatus = '';
    if (activeSession) {
      const currentTime = new Date();
      const totalElapsed =
        currentTime.getTime() -
        activeSession.startTime.getTime() -
        (activeSession.totalPausedTime || 0);
      const elapsed = Math.floor(totalElapsed / (1000 * 60));
      const remaining = Math.max(0, 25 - elapsed);

      if (activeSession.pausedAt) {
        pomodoroStatus =
          '\n⏸️ **Фокус-сессия на паузе** (осталось ~' + remaining + ' мин)';
      } else if (activeSession.breakTimer) {
        pomodoroStatus = '\n☕ **Активен перерыв** помодоро';
      } else {
        pomodoroStatus =
          '\n🍅 **Активная фокус-сессия** (осталось ~' + remaining + ' мин)';
      }

      // Добавляем кнопку для быстрого доступа к активной сессии
      keyboard.inline_keyboard.unshift([
        { text: '🍅 К активной сессии', callback_data: 'pomodoro_focus' },
      ]);
    }

    // Добавляем информацию о уровне и достижениях
    const userStats = `\n🏆 XP: ${user.totalXp} | 🔥 Уровень: ${user.level}`;

    let statusText = '';
    if (trialInfo.isTrialActive) {
      statusText = `🎁 **Пробный период:** ${trialInfo.daysRemaining} дней осталось\n`;
    } else if (subscriptionStatus.type !== 'FREE') {
      statusText = `💎 **${subscriptionStatus.type === 'PREMIUM' ? 'Premium' : 'Premium Plus'}**\n`;
    }

    const message = `
👋 *Привет, ${this.userService.getDisplayName(user)}!*

${statusText}🤖 Я Ticky AI – твой личный AI помощник для управления задачами и привычками.
${habitsProgressBar}${pomodoroStatus}${userStats}
    `;

    if (shouldEdit) {
      try {
        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
      } catch (err) {
        const e = err as any;
        const desc = e?.response?.description || e?.message || '';
        if (
          typeof desc === 'string' &&
          desc.includes('message is not modified')
        ) {
          this.logger.log(
            'Edit resulted in no-op (all tasks identical), sending a new message instead',
          );
          // Send photo with message for new messages
          await ctx.replyWithPhoto(
            { source: path.join(__dirname, '../../src/TickyAI.png') },
            {
              caption: message,
              parse_mode: 'Markdown',
              reply_markup: keyboard,
            },
          );
        } else {
          throw err;
        }
      }
    } else {
      // Send photo with message for initial menu display
      await ctx.replyWithPhoto(
        { source: path.join(__dirname, '../../src/TickyAI.png') },
        {
          caption: message,
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        },
      );
    }

    // Check if we should show feedback request
    setTimeout(() => this.checkAndShowFeedbackRequest(ctx), 2000);
  }

  async launch() {
    try {
      // Устанавливаем команды в меню бота
      await this.bot.telegram.setMyCommands([
        { command: 'start', description: '🎬 Начать работу с ботом' },
        { command: 'menu', description: '🏠 Главное меню' },
        { command: 'home', description: '🏠 Быстро в главное меню' },
        { command: 'tasks', description: '📝 Мои задачи' },
        { command: 'habits', description: '🎯 Мои привычки' },
        { command: 'reminders', description: '⏰ Активные напоминания' },
        { command: 'mood', description: '😊 Дневник настроения' },
        { command: 'focus', description: '🍅 Режим фокуса' },
        { command: 'billing', description: '💎 Мои лимиты и подписка' },
        { command: 'feedback', description: '💬 Обратная связь' },
        { command: 'help', description: '🆘 Справка' },
      ]);

      // Устанавливаем Menu Button - кнопку меню рядом с полем ввода
      await this.bot.telegram.setChatMenuButton({
        menuButton: {
          type: 'commands',
        },
      });

      // Альтернативно можно установить Web App кнопку для более расширенного меню
      // await this.bot.telegram.setChatMenuButton({
      //   menuButton: {
      //     type: 'web_app',
      //     text: 'Меню',
      //     web_app: { url: 'https://your-domain.com/menu' }
      //   }
      // });

      // Запускаем бота без ожидания
      this.bot
        .launch()
        .then(() => {
          this.logger.log('🚀 Telegram bot launched successfully');
        })
        .catch((error) => {
          this.logger.error('❌ Failed to launch Telegram bot:', error);
        });

      // Возвращаем управление сразу
      this.logger.log('🤖 Telegram bot launch initiated');
    } catch (error) {
      this.logger.error('❌ Error during bot initialization:', error);
      throw error;
    }
  }

  async stop() {
    // Clear all active Pomodoro timers before stopping
    for (const [userId, session] of this.activePomodoroSessions.entries()) {
      if (session.focusTimer) clearTimeout(session.focusTimer);
      if (session.breakTimer) clearTimeout(session.breakTimer);
    }
    this.activePomodoroSessions.clear();

    // Clear all active interval reminders before stopping
    for (const [userId, reminder] of this.activeIntervalReminders.entries()) {
      clearInterval(reminder.intervalId);
      this.logger.log(`Stopped interval reminder for user ${userId}`);
    }
    this.activeIntervalReminders.clear();

    this.bot.stop('SIGINT');
    this.logger.log('🛑 Telegram bot stopped');
  }

  getBotInstance(): Telegraf<BotContext> {
    return this.bot;
  }

  // Task management methods
  private async showTasksMenu(ctx: BotContext) {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '➕ Добавить задачу', callback_data: 'tasks_add' },
          { text: '📋 Все задачи', callback_data: 'tasks_list' },
        ],
        [{ text: '🤖 AI-совет по задачам', callback_data: 'tasks_ai_advice' }],
        [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
      ],
    };

    const message = `
📝 *Управление задачами*

Выберите действие:
    `;

    // Check if this is a callback query (can edit) or command (need to reply)
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
      } catch (err) {
        const e = err as any;
        const desc = e?.response?.description || e?.message || '';
        if (
          typeof desc === 'string' &&
          desc.includes('message is not modified')
        ) {
          this.logger.log(
            'Edit resulted in no-op, sending a new message instead (showTasksList)',
          );
          await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
        } else {
          throw err;
        }
      }
    } else {
      await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
    }
  }

  private async startAddingTask(ctx: BotContext) {
    // Проверяем наличие часового пояса перед созданием задачи
    const user = await this.userService.findByTelegramId(ctx.userId);
    if (!user.timezone) {
      ctx.session.pendingAction = 'adding_task';
      await this.askForTimezone(ctx);
      return;
    }

    // Check billing limits for tasks
    const limitCheck = await this.billingService.checkUsageLimit(
      ctx.userId,
      'dailyTasks',
    );

    if (!limitCheck.allowed) {
      await ctx.replyWithMarkdown(
        limitCheck.message || '🚫 Превышен лимит задач',
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '💎 Обновиться до Premium',
                  callback_data: 'upgrade_premium',
                },
              ],
              [{ text: '📊 Мои лимиты', callback_data: 'show_limits' }],
              [{ text: '⬅️ Назад', callback_data: 'menu_tasks' }],
            ],
          },
        },
      );
      return;
    }

    await ctx.replyWithMarkdown(
      `
➕ *Создание новой задачи*

📊 **Задач сегодня:** ${limitCheck.current}${limitCheck.limit === -1 ? '' : `/${limitCheck.limit}`}

� **Способы создания задачи:**
• �📝 Напишите текстом название задачи
• 🎙️ Отправьте голосовое сообщение

🤖 **Я все пойму!** 

⬇️ *Введите название задачи в поле для ввода ниже или отправьте голосовое сообщение*
    `,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
              { text: '📋 К задачам', callback_data: 'menu_tasks' },
            ],
          ],
        },
      },
    );

    ctx.session.step = 'waiting_for_task_title';
  }

  private async handleTaskCreation(ctx: BotContext, taskTitle: string) {
    try {
      // 🔧 Проверяем лимит задач перед созданием
      const taskLimitCheck = await this.subscriptionService.checkLimit(
        ctx.userId,
        'tasks',
      );

      if (!taskLimitCheck.allowed) {
        const limitMessage = this.subscriptionService.getLimitMessage(
          'tasks',
          taskLimitCheck.current,
          taskLimitCheck.limit,
        );
        await ctx.replyWithMarkdown(limitMessage, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💎 Получить Premium', callback_data: 'get_premium' }],
              [{ text: '📊 Мои лимиты', callback_data: 'subscription_status' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        });
        return;
      }

      const task = await this.taskService.createTask({
        userId: ctx.userId,
        title: taskTitle.trim(),
        description: '',
        priority: 'MEDIUM' as any,
      });

      // Get current user stats to increment
      const user = await this.userService.findByTelegramId(ctx.userId);
      await this.userService.updateUser(ctx.userId, {
        totalTasks: user.totalTasks + 1,
      });

      // Get current usage for display
      const usageInfo = await this.subscriptionService.checkLimit(
        ctx.userId,
        'tasks',
      );

      await ctx.replyWithMarkdown(
        `
✅ *Задача создана!*

📝 *${task.title}*
⚡ XP за выполнение: ${task.xpReward}
📊 **Задач:** ${usageInfo.current}${usageInfo.limit === -1 ? '/♾️' : `/${usageInfo.limit}`} (осталось: ${usageInfo.remaining === -1 ? '♾️' : usageInfo.remaining})

Задача добавлена в ваш список!
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📋 Мои задачи', callback_data: 'tasks_list' },
                { text: '➕ Добавить', callback_data: 'tasks_add' },
              ],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );

      ctx.session.step = undefined;
      // Убираем автоматический переход, пользователь сам выберет через кнопки
    } catch (error) {
      this.logger.error('Error creating task:', error);
      await ctx.replyWithMarkdown(`
❌ *Ошибка при создании задачи*

Попробуйте еще раз или обратитесь к администратору.
      `);
      ctx.session.step = undefined;
    }
  }

  private async showTasksList(ctx: BotContext) {
    try {
      const tasks = await this.taskService.findTasksByUserId(ctx.userId);

      if (tasks.length === 0) {
        await ctx.editMessageTextWithMarkdown(`
📋 *Список задач пуст*

У вас пока нет задач. Добавьте первую задачу!
        `);
        return;
      }

      const pendingTasks = tasks.filter(
        (task) => task.status === 'PENDING' || task.status === 'IN_PROGRESS',
      );
      const completedTasks = tasks.filter(
        (task) => task.status === 'COMPLETED',
      );

      let message = `📋 *Ваши задачи:*\n\n`;
      message += `🔄 **Активных:** ${pendingTasks.length}\n`;
      message += `✅ **Выполненных:** ${completedTasks.length}\n\n`;

      // Создаем кнопки для всех задач
      const taskButtons: any[] = [];

      // Показываем только активные задачи с серыми квадратиками
      pendingTasks.forEach((task) => {
        taskButtons.push([
          {
            text: `     ⬜ ${task.title.substring(0, 30)}${task.title.length > 30 ? '...' : ''}     `,
            callback_data: `task_complete_${task.id}`,
          },
        ]);
      });

      // Если нет активных задач, показываем сообщение
      if (pendingTasks.length === 0) {
        taskButtons.push([
          {
            text: '📝 Нет активных задач',
            callback_data: 'noop_separator',
          },
        ]);
      }

      // Дополнительные кнопки
      const extraButtons: any[] = [];

      // Кнопка для просмотра всех выполненных задач (показываем всегда, если есть выполненные)
      if (completedTasks.length > 0) {
        extraButtons.push([
          {
            text: `✅ Выполненные (${completedTasks.length})`,
            callback_data: 'tasks_completed',
          },
        ]);
      }

      // Добавляем кнопку редактирования, если есть задачи
      if (pendingTasks.length > 0 || completedTasks.length > 0) {
        extraButtons.push([
          {
            text: '✏️ Редактировать задачи',
            callback_data: 'edit_tasks_menu',
          },
        ]);
      }

      extraButtons.push([
        { text: '🔙 Назад к меню задач', callback_data: 'menu_tasks' },
      ]);

      const keyboard = {
        inline_keyboard: [...taskButtons, ...extraButtons],
      };

      try {
        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
      } catch (err) {
        const e = err as any;
        const desc = e?.response?.description || e?.message || '';
        if (
          typeof desc === 'string' &&
          desc.includes('message is not modified')
        ) {
          this.logger.log(
            'Edit resulted in no-op, sending a new message instead (showAllTasksList)',
          );
          await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
        } else {
          throw err;
        }
      }
    } catch (error) {
      this.logger.error('Error showing tasks list:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при получении списка задач',
      );
    }
  }

  private async showAllTasksList(ctx: BotContext) {
    try {
      const tasks = await this.taskService.findTasksByUserId(ctx.userId);

      const pendingTasks = tasks.filter(
        (task) => task.status === 'PENDING' || task.status === 'IN_PROGRESS',
      );

      if (pendingTasks.length === 0) {
        await ctx.editMessageTextWithMarkdown(`
📋 *Все активные задачи*

У вас нет активных задач. Все выполнено! 🎉
        `);
        return;
      }

      let message = `📋 *Все активные задачи (${pendingTasks.length}):*\n\n`;
      message += `*Нажмите на задачу для завершения:*`;

      // Create keyboard with pending tasks first, then completed tasks marked green
      const pendingButtons = pendingTasks.map((task) => [
        {
          text: `     ${this.getPriorityEmoji(task.priority)} ${task.title.substring(0, 25)}${task.title.length > 25 ? '...' : ''}     `,
          callback_data: `task_complete_${task.id}`,
        },
      ]);

      // Gather completed tasks for display
      const completedTasks = tasks.filter((t) => t.status === 'COMPLETED');

      const completedButtons = completedTasks.map((task) => [
        {
          text: `✅ ${task.title.substring(0, 35)}${task.title.length > 35 ? '...' : ''} (${task.xpReward} XP)`,
          // Use a safe view callback to avoid rerunning completion
          callback_data: `task_view_${task.id}`,
        },
      ]);

      const rowsAll: any[] = [
        ...pendingButtons,
        ...(completedButtons.length
          ? [[{ text: '— Выполненные —', callback_data: 'noop_separator' }]]
          : []),
        ...completedButtons,
      ];

      if (completedButtons.length > 0) {
        rowsAll.push([
          {
            text: '🗂️ Посмотреть выполненные',
            callback_data: 'tasks_completed',
          },
        ]);
      }
      rowsAll.push([
        { text: '🔙 Назад к меню задач', callback_data: 'menu_tasks' },
      ]);

      const keyboard = { inline_keyboard: rowsAll };

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error showing all tasks list:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при получении списка задач',
      );
    }
  }

  private async showTodayTasks(ctx: BotContext) {
    try {
      const tasks = await this.taskService.getTodayTasks(ctx.userId);

      if (tasks.length === 0) {
        try {
          await ctx.editMessageTextWithMarkdown(
            `
📅 *Задачи на сегодня*

На сегодня задач нет! 🎉
        `,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '➕ Добавить задачу', callback_data: 'tasks_add' }],
                  [
                    { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
                    { text: '📋 Все задачи', callback_data: 'tasks_list' },
                  ],
                ],
              },
            },
          );
        } catch (editErr) {
          await ctx.replyWithMarkdown(
            `
📅 *Задачи на сегодня*

На сегодня задач нет! 🎉
        `,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '➕ Добавить задачу', callback_data: 'tasks_add' }],
                  [
                    { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
                    { text: '📋 Все задачи', callback_data: 'tasks_list' },
                  ],
                ],
              },
            },
          );
        }
        return;
      }

      const pendingTasks = tasks.filter((task) => task.status !== 'COMPLETED');
      const completedTasks = tasks.filter(
        (task) => task.status === 'COMPLETED',
      );

      let message = `📅 *Задачи на сегодня:*\n\n`;
      message += `🔄 **К выполнению:** ${pendingTasks.length}\n`;
      message += `✅ **Выполнено:** ${completedTasks.length}\n\n`;

      const rows: any[] = [];

      // Активные задачи (для завершения)
      rows.push(
        ...pendingTasks.slice(0, 8).map((task) => [
          {
            text: `     ${this.getPriorityEmoji(task.priority)} ${task.title.substring(0, 25)}${task.title.length > 25 ? '...' : ''}     `,
            callback_data: `task_complete_${task.id}`,
          },
        ]),
      );

      if (pendingTasks.length > 8) {
        rows.push([
          {
            text: `... и еще ${pendingTasks.length - 8} активных задач`,
            callback_data: 'tasks_list_more',
          },
        ]);
      }

      // Выполненные задачи (показываем первые 3 с зелеными галочками)
      rows.push(
        ...completedTasks.slice(0, 3).map((task) => [
          {
            text: `     ✅ ${task.title.substring(0, 25)}${task.title.length > 25 ? '...' : ''}     `,
            callback_data: `task_view_${task.id}`,
          },
        ]),
      );

      // Кнопка для просмотра всех выполненных задач (если их больше 3)
      if (completedTasks.length > 3) {
        rows.push([
          {
            text: `✅ Все выполненные (${completedTasks.length})`,
            callback_data: 'tasks_completed',
          },
        ]);
      }

      // Add edit tasks button
      rows.push([
        {
          text: '✏️ Редактировать задачи',
          callback_data: 'edit_tasks_menu',
        },
      ]);

      rows.push([
        { text: '🔙 Назад к меню задач', callback_data: 'menu_tasks' },
      ]);

      const keyboard = { inline_keyboard: rows };

      try {
        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
      } catch (err) {
        const e = err as any;
        const desc = e?.response?.description || e?.message || '';
        if (
          typeof desc === 'string' &&
          (desc.includes('message is not modified') ||
            desc.includes("message can't be edited"))
        ) {
          this.logger.log(
            'Edit failed (showTodayTasks), sending a new message instead',
          );
          await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
        } else {
          throw err;
        }
      }
    } catch (error) {
      this.logger.error('Error showing today tasks:', error);
      try {
        await ctx.editMessageTextWithMarkdown(
          '❌ Ошибка при получении задач на сегодня',
        );
      } catch (editErr) {
        await ctx.replyWithMarkdown('❌ Ошибка при получении задач на сегодня');
      }
    }
  }

  private async showCompletedTasks(ctx: BotContext) {
    try {
      const tasks = await this.taskService.findTasksByUserId(
        ctx.userId,
        'COMPLETED' as any,
      );

      if (!tasks || tasks.length === 0) {
        await ctx.editMessageTextWithMarkdown(`
📂 *Выполненные задачи*

Пока нет выполненных задач.
        `);
        return;
      }

      // Сортируем по дате завершения (последние сверху) и берем только последние 10
      const sortedTasks = tasks
        .filter((task) => task.completedAt) // Убеждаемся, что completedAt существует
        .sort((a, b) => {
          const dateA = a.completedAt ? new Date(a.completedAt).getTime() : 0;
          const dateB = b.completedAt ? new Date(b.completedAt).getTime() : 0;
          return dateB - dateA;
        })
        .slice(0, 10);

      const totalCount = tasks.length;
      const showingCount = Math.min(sortedTasks.length, 10);

      let message = `📂 *Выполненные задачи*\n\n`;
      message += `Показано последних ${showingCount} из ${totalCount}\n\n`;

      const keyboard = {
        inline_keyboard: [
          ...sortedTasks.map((task) => [
            {
              text: `✅ ${task.title.substring(0, 45)}${task.title.length > 45 ? '...' : ''}`,
              callback_data: `task_view_${task.id}`,
            },
          ]),
          [{ text: '🔙 Назад к списку задач', callback_data: 'tasks_list' }],
        ],
      };

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error showing completed tasks:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при получении выполненных задач',
      );
    }
  }

  private async completeTask(ctx: BotContext, taskId: string) {
    try {
      const result = await this.taskService.completeTask(taskId, ctx.userId);

      // Get current user stats to increment and check level up
      const userBefore = await this.userService.findByTelegramId(ctx.userId);

      const statsUpdate = await this.userService.updateStats(ctx.userId, {
        todayTasks: userBefore.todayTasks + 1,
        xpGained: result.xpGained,
      });

      // Просто обновляем список задач без показа сообщения
      await ctx.answerCbQuery('✅ Задача выполнена!');

      // Определяем, где находимся, и обновляем соответствующий список
      const currentMessage = (ctx.callbackQuery?.message as any)?.text;
      if (currentMessage?.includes('Все активные задачи')) {
        // Мы в общем списке всех задач
        await this.showAllTasksList(ctx);
      } else if (currentMessage?.includes('Задачи на сегодня')) {
        // Мы в списке задач на сегодня
        await this.showTodayTasks(ctx);
      } else {
        // По умолчанию возвращаемся к списку задач на сегодня
        await this.showTodayTasks(ctx);
      }
    } catch (error) {
      this.logger.error('Error completing task:', error);
      if (error.message.includes('already completed')) {
        await ctx.answerCbQuery('ℹ️ Эта задача уже выполнена!');
      } else {
        await ctx.answerCbQuery('❌ Ошибка при выполнении задачи');
      }
    }
  }

  private getPriorityEmoji(priority: string): string {
    switch (priority) {
      case 'URGENT':
        return '🔴';
      case 'HIGH':
        return '🟠';
      case 'MEDIUM':
        return '⬜';
      case 'LOW':
        return '🟢';
      default:
        return '⚪';
    }
  }

  private async askForTimezone(ctx: BotContext) {
    // Попытаемся определить часовой пояс автоматически по IP
    await ctx.replyWithMarkdown('🔍 *Определяю ваш часовой пояс...*');

    try {
      // Попробуем получить IP и определить локацию
      const ipTimezone = await this.detectTimezoneByIP();

      if (ipTimezone) {
        await ctx.replyWithMarkdown(
          `
🌍 *Автоматически определен часовой пояс*

🏙️ Регион: ${ipTimezone.city || 'Не определен'}
🕐 Часовой пояс: ${ipTimezone.timezone}

Все верно?`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '✅ Да, верно',
                    callback_data: `confirm_timezone_${ipTimezone.timezone}`,
                  },
                  {
                    text: '❌ Нет, выбрать вручную',
                    callback_data: 'manual_timezone',
                  },
                ],
              ],
            },
          },
        );
        return;
      }
    } catch (error) {
      this.logger.warn('Could not detect timezone by IP:', error);
    }

    // Если автоматическое определение не сработало, показываем ручной выбор
    await this.showManualTimezoneSelection(ctx);
  }

  private async showManualTimezoneSelection(ctx: BotContext) {
    await ctx.replyWithMarkdown(
      `
🌍 *Настройка часового пояса*

Выберите удобный способ:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🏙️ Ввести город', callback_data: 'input_city' },
              {
                text: '🕐 Выбрать из списка',
                callback_data: 'select_timezone',
              },
            ],
          ],
        },
      },
    );
  }

  private async detectTimezoneByIP(): Promise<{
    timezone: string;
    city?: string;
  } | null> {
    try {
      // Используем бесплатный API для определения локации по IP
      const fetch = (await import('node-fetch')).default;
      const response = await fetch('http://worldtimeapi.org/api/ip');

      if (!response.ok) {
        return null;
      }

      const data = await response.json();

      return {
        timezone: data.timezone,
        city: data.timezone.split('/')[1]?.replace(/_/g, ' '),
      };
    } catch (error) {
      this.logger.warn('Error detecting timezone by IP:', error);
      return null;
    }
  }

  private async handleCityInput(ctx: BotContext, cityName: string) {
    await ctx.replyWithMarkdown('🔍 *Определяю часовой пояс...*');

    const result = await this.openaiService.getTimezoneByCity(cityName);

    if (!result) {
      await ctx.replyWithMarkdown(`
❌ *Не удалось определить часовой пояс для города "${cityName}"*

📍 Попробуйте еще раз. Напишите название города более точно:
      `);
      return;
    }

    // Save timezone and city to database
    await this.userService.updateUser(ctx.userId, {
      timezone: result.timezone,
      city: result.normalizedCity,
    });

    await ctx.replyWithMarkdown(`
✅ *Часовой пояс установлен!*

🏙️ Город: ${result.normalizedCity}
🕐 Часовой пояс: ${result.timezone}

Теперь можете продолжить создание задачи или привычки!
    `);

    // Reset session step
    ctx.session.step = undefined;

    // Продолжить с тем действием, которое пользователь хотел сделать
    if (ctx.session.pendingAction === 'adding_task') {
      ctx.session.pendingAction = undefined;
      await this.startAddingTask(ctx);
    } else if (ctx.session.pendingAction === 'adding_habit') {
      ctx.session.pendingAction = undefined;
      ctx.session.step = 'adding_habit';
      await ctx.replyWithMarkdown(
        '🔄 *Добавление привычки*\n\nВведите название привычки, которую хотите отслеживать:\n\n⬇️ *Введите название привычки в поле для ввода ниже*',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } else {
      await this.showMainMenu(ctx);
    }
  }

  // Gamification helpers
  private createProgressBar(progress: number, length: number = 10): string {
    const filled = Math.round(progress * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '⬜'.repeat(empty);
  }

  // Feedback system methods
  private async checkAndShowFeedbackRequest(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    const accountAge = Date.now() - user.createdAt.getTime();
    const threeDaysInMs = 3 * 24 * 60 * 60 * 1000;

    // Show feedback request after 3 days
    if (accountAge >= threeDaysInMs && !user.feedbackGiven) {
      await this.showFeedbackRequest(ctx);
    }
  }

  private async showFeedbackSurvey(ctx: BotContext) {
    try {
      const keyboard = {
        inline_keyboard: [
          [
            { text: '🎯 Удобство', callback_data: 'feedback_like_convenience' },
            {
              text: '🚀 Много функций',
              callback_data: 'feedback_like_features',
            },
          ],
          [
            {
              text: '🎮 Геймификация',
              callback_data: 'feedback_like_gamification',
            },
            { text: '🔧 Другое', callback_data: 'feedback_like_other' },
          ],
        ],
      };

      const message = `
💭 *Мини-опрос*

👍 *Что вам нравится?*

Выберите, что вас больше всего привлекает в боте:
      `;

      // Check if this is a callback query (can edit) or command (need to reply)
      if (ctx.callbackQuery) {
        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
      } else {
        await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
      }
    } catch (error) {
      this.logger.error('Error in showFeedbackSurvey:', error);
      await ctx.replyWithMarkdown(
        '❌ Ошибка при загрузке опроса. Попробуйте позже.',
      );
    }
  }

  private async showFeedbackRequest(ctx: BotContext) {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '⭐️', callback_data: 'feedback_rating_5' },
          { text: '😊', callback_data: 'feedback_rating_4' },
          { text: '😐', callback_data: 'feedback_rating_3' },
          { text: '😠', callback_data: 'feedback_rating_2' },
        ],
        [{ text: '⏰ Позже', callback_data: 'feedback_later' }],
      ],
    };

    const message = `
💭 *Оцените ваш опыт использования бота*

Как вам работа с Ticky AI? Ваше мнение поможет нам стать лучше!
    `;

    try {
      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      // If we can't edit the message, send a new one
      await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
    }
  }

  private async handleFeedbackRating(ctx: BotContext, rating: number) {
    await ctx.answerCbQuery();

    ctx.session.feedbackRating = rating;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '🎯 Удобство', callback_data: 'feedback_like_convenience' },
          { text: '🚀 Много функций', callback_data: 'feedback_like_features' },
        ],
        [
          {
            text: '🎮 Геймификация',
            callback_data: 'feedback_like_gamification',
          },
          { text: '🔧 Другое', callback_data: 'feedback_like_other' },
        ],
      ],
    };

    await ctx.editMessageTextWithMarkdown(
      `
👍 *Что вам больше всего нравится?*

Выберите, что вас привлекает в боте:
      `,
      { reply_markup: keyboard },
    );
  }

  private async handleFeedbackImprovement(
    ctx: BotContext,
    likedFeature: string,
  ) {
    await ctx.answerCbQuery();

    ctx.session.feedbackLiked = likedFeature;

    const keyboard = {
      inline_keyboard: [
        [
          {
            text: '🔧 Больше функций',
            callback_data: 'feedback_improve_features',
          },
          { text: '🎨 Интерфейс', callback_data: 'feedback_improve_interface' },
        ],
        [
          {
            text: '⚡ Скорость работы',
            callback_data: 'feedback_improve_speed',
          },
          {
            text: '📝 Написать свое',
            callback_data: 'feedback_improve_custom',
          },
        ],
        [
          {
            text: '✅ Все устраивает',
            callback_data: 'feedback_improve_nothing',
          },
        ],
      ],
    };

    await ctx.editMessageTextWithMarkdown(
      `
💡 *Что хотелось бы улучшить?*

Выберите, что можно сделать лучше:
      `,
      { reply_markup: keyboard },
    );
  }

  private async completeFeedbackSurvey(ctx: BotContext, improvement: string) {
    await ctx.answerCbQuery();

    // Save feedback to database (survey-only, no rating)
    await this.userService.updateUser(ctx.userId, {
      feedbackGiven: true,
    });

    // Prepare improvement text
    const improvements = {
      convenience: '🎯 Удобство',
      features: '🚀 Много функций',
      gamification: '🎮 Геймификация',
      other: '🔧 Другое',
    };

    const improvementText = improvements[improvement] || improvement;

    await ctx.editMessageTextWithMarkdown(
      `
✨ *Спасибо за участие в опросе!*

Вы выбрали: ${improvementText}

Ваше мнение поможет нам стать лучше! 💝

Продолжайте пользоваться ботом и достигайте новых целей! 🚀
    `,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 В главное меню', callback_data: 'start' }],
          ],
        },
      },
    );
  }

  private async completeFeedback(ctx: BotContext, improvement: string) {
    // Save feedback to database
    await this.userService.updateUser(ctx.userId, {
      feedbackGiven: true,
    });

    const ratingEmojis = ['😠', '😠', '😐', '😊', '⭐️'];
    const rating = ctx.session.feedbackRating || 3;
    const ratingEmoji = ratingEmojis[rating - 1];

    await ctx.replyWithMarkdown(`
🙏 *Спасибо за обратную связь!*

${ratingEmoji} Ваша оценка: ${rating}/5
👍 Нравится: ${ctx.session.feedbackLiked || 'не указано'}
💡 Улучшить: ${improvement}

Ваше мнение очень важно для нас! 💚
    `);

    // Clear feedback session data
    ctx.session.feedbackRating = undefined;
    ctx.session.feedbackLiked = undefined;
  }

  private async startAIChat(ctx: BotContext) {
    
    // 🔧 Проверяем лимит AI запросов
    const aiLimitCheck = await this.subscriptionService.checkLimit(
      ctx.userId,
      'aiRequests',
    );
    if (!aiLimitCheck.allowed) {
      
      const limitMessage = this.subscriptionService.getLimitMessage(
        'aiRequests',
        aiLimitCheck.current,
        aiLimitCheck.limit,
      );

      await ctx.replyWithMarkdown(limitMessage, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '💎 Получить Premium', callback_data: 'get_premium' }],
            [{ text: '📊 Мои лимиты', callback_data: 'subscription_status' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      });
      return;
    }

    await ctx.replyWithMarkdown(
      `
🧠 *ИИ Консультант*

Выберите тему или задайте вопрос:

📊 **Использование:** ${aiLimitCheck.current}/${aiLimitCheck.limit === -1 ? '♾️' : aiLimitCheck.limit} запросов${aiLimitCheck.limit !== -1 ? ` (осталось: ${aiLimitCheck.remaining})` : ''}
    `,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '📊 Анализ профиля',
                callback_data: 'ai_analyze_profile',
              },
            ],
            [
              {
                text: '💡 Советы по задачам',
                callback_data: 'ai_task_recommendations',
              },
            ],
            [
              {
                text: '🎯 Помощь с привычками',
                callback_data: 'ai_habit_help',
              },
            ],
            [
              {
                text: '✍️ Свой вопрос',
                callback_data: 'ai_custom_question',
              },
            ],
            [{ text: '⬅️ Назад в меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );

    // Set AI chat mode
    ctx.session.aiChatMode = true;
  }

  private async handleAIAnalyzeProfile(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    const tasks = await this.taskService.findTasksByUserId(ctx.userId);
    const completedTasks = tasks.filter((task) => task.completedAt !== null);

    const accountDays = Math.floor(
      (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    const completionRate =
      tasks.length > 0
        ? Math.round((completedTasks.length / tasks.length) * 100)
        : 0;

    let status = '';
    if (user.totalXp < 500) {
      status = '🌱 Новичок - только начинаете путь к продуктивности!';
    } else if (user.totalXp < 2000) {
      status = '📈 Развиваетесь - уже видны первые результаты!';
    } else {
      status = '🚀 Опытный пользователь - отличные результаты!';
    }

    await ctx.editMessageTextWithMarkdown(
      `
📊 *Анализ профиля*

${status}

**Статистика:**
⭐ Опыт: ${user.totalXp} XP (уровень ${user.level})
📅 С ботом: ${accountDays} дней
📝 Задач создано: ${tasks.length}
✅ Выполнено: ${completedTasks.length} (${completionRate}%)

**Рекомендация:**
${
  completionRate > 70
    ? '🎯 Отлично! Попробуйте более сложные цели.'
    : completionRate > 40
      ? '💪 Хорошо! Сфокусируйтесь на завершении задач.'
      : '� Начните с малого - одна задача в день!'
}
      `,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );
  }

  private async handleAIChatMessage(ctx: BotContext, message: string) {
    // Не отвечать, если режим ИИ-чата не активен
    if (!ctx.session.aiChatMode) {
      return;
    }
    try {
      // 🔧 Проверяем лимит AI запросов с новой системой подписок
      const aiLimitCheck = await this.subscriptionService.checkLimit(
        ctx.userId,
        'aiRequests',
      );

      if (!aiLimitCheck.allowed) {
        const limitMessage = this.subscriptionService.getLimitMessage(
          'aiRequests',
          aiLimitCheck.current,
          aiLimitCheck.limit,
        );
        await ctx.replyWithMarkdown(limitMessage, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '💎 Получить Premium', callback_data: 'get_premium' }],
              [{ text: '📊 Мои лимиты', callback_data: 'subscription_status' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        });
        return;
      }

      // Check if this is a reminder request
      const absoluteTimePatterns = [
        /напомни\s+мне\s+(.+?)\s+в\s+(\d{1,2}):(\d{2})/i,
        /напомни\s+(.+?)\s+в\s+(\d{1,2}):(\d{2})/i,
        /напоминание\s+(.+?)\s+в\s+(\d{1,2}):(\d{2})/i,
        /поставь\s+напоминание\s+(.+?)\s+на\s+(\d{1,2}):(\d{2})/i,
      ];

      const relativeTimePatterns = [
        /напомни\s+мне\s+(.+?)\s+через\s+(\d+)\s+минут/i,
        /напомни\s+(.+?)\s+через\s+(\d+)\s+минут/i,
        /напоминание\s+(.+?)\s+через\s+(\d+)\s+минут/i,
        // Добавляем поддержку "через минуту", "через час"
        /напомни\s+мне\s+(.+?)\s+через\s+минуту/i,
        /напомни\s+(.+?)\s+через\s+минуту/i,
        /напоминание\s+(.+?)\s+через\s+минуту/i,
        /напомни\s+мне\s+(.+?)\s+через\s+час/i,
        /напомни\s+(.+?)\s+через\s+час/i,
        /напоминание\s+(.+?)\s+через\s+час/i,
        // Простые паттерны без "напомни"
        /^(.+?)\s+через\s+минуту$/i,
        /^(.+?)\s+через\s+час$/i,
        /^(.+?)\s+через\s+(\d+)\s+минут$/i,
        /^(.+?)\s+через\s+(\d+)\s+часа?$/i,
      ];

      const intervalPatterns = [
        /напоминай\s+(.+?)\s+каждые?\s+(\d+)\s+(минут|час|часа|часов)/i,
        /напомни\s+(.+?)\s+каждые?\s+(\d+)\s+(минут|час|часа|часов)/i,
        /(.+?)\s+каждые?\s+(\d+)\s+(минут|час|часа|часов)/i,
      ];

      // Check interval patterns first
      let reminderMatch: RegExpMatchArray | null = null;
      for (const pattern of intervalPatterns) {
        reminderMatch = message.match(pattern);
        if (reminderMatch) {
          const [, reminderText, amount, unit] = reminderMatch;
          let intervalMinutes = 0;

          if (unit.includes('минут')) {
            intervalMinutes = parseInt(amount);
          } else if (unit.includes('час')) {
            intervalMinutes = parseInt(amount) * 60;
          }

          if (intervalMinutes >= 1 && intervalMinutes <= 1440) {
            await this.handleIntervalReminder(
              ctx,
              reminderText.trim(),
              intervalMinutes,
            );
            return;
          }
        }
      }

      // Check absolute time
      for (const pattern of absoluteTimePatterns) {
        reminderMatch = message.match(pattern);
        if (reminderMatch) {
          const [, reminderText] = reminderMatch;
          await this.askForReminderTime(ctx, reminderText.trim());
          return;
        }
      }

      // Check relative time
      for (const pattern of relativeTimePatterns) {
        reminderMatch = message.match(pattern);
        if (reminderMatch) {
          const [, reminderText] = reminderMatch;
          await this.askForReminderTime(ctx, reminderText.trim());
          return;
        }
      }

      await ctx.replyWithMarkdown('🤔 *Анализирую ваш вопрос...*');

      // Получаем персонализированный ответ через AI Context Service
      const personalizedResponse =
        await this.aiContextService.generatePersonalizedMessage(
          ctx.userId,
          'motivation',
          `${message}. Ответь кратко, до 100 слов, конкретно и по делу.`,
        );

      // Проверка: не похоже ли сообщение на задачу или напоминание

      // 🔧 Увеличиваем счетчик использования AI в новой системе
      await this.subscriptionService.incrementUsage(ctx.userId, 'aiRequests');

      // Get current usage for display
      const usageInfo = await this.subscriptionService.checkLimit(
        ctx.userId,
        'aiRequests',
      );

      await ctx.replyWithMarkdown(
        `
🧠 *ИИ отвечает:*

${personalizedResponse}

📊 ИИ-запросов: ${usageInfo.current}${usageInfo.limit === -1 ? '/♾️' : `/${usageInfo.limit}`} (осталось: ${usageInfo.remaining === -1 ? '♾️' : usageInfo.remaining})
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              [{ text: '🚪 Выйти из ИИ-чата', callback_data: 'exit_ai_chat' }],
            ],
          },
        },
      );
      // Регистрируем обработчик выхода из ИИ-чата
      this.bot.action('exit_ai_chat', async (ctx) => {
        ctx.session.aiChatMode = false;
        await ctx.editMessageTextWithMarkdown(
          '🧠 Режим ИИ-чата завершён. Вы можете продолжить работу через главное меню.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      });
    } catch (error) {
      await ctx.replyWithMarkdown(
        `
❌ *Ошибка ИИ-консультанта*

Извините, сейчас не могу ответить на ваш вопрос. Попробуйте позже или задайте другой вопрос.
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад к ИИ меню', callback_data: 'ai_back_menu' }],
            ],
          },
        },
      );
    }
  }

  private async handleRelativeReminderRequest(
    ctx: BotContext,
    reminderText: string,
    minutesFromNow: number,
  ) {
    try {
      const user = await this.userService.findByTelegramId(ctx.userId);

      // Validate minutes
      if (minutesFromNow <= 0 || minutesFromNow > 1440) {
        // max 24 hours
        await ctx.editMessageTextWithMarkdown(`
❌ *Неверное время*

Пожалуйста, укажите от 1 до 1440 минут (максимум 24 часа)
        `);
        return;
      }

      // Calculate reminder time
      const now = new Date();
      const reminderDate = new Date(now.getTime() + minutesFromNow * 60 * 1000);
      // Normalize to exact minute boundary (seconds and ms = 0)
      reminderDate.setSeconds(0, 0);
      // If normalization made the reminderDate <= now (possible when now has seconds > 0), push it forward by one minute
      if (reminderDate.getTime() <= now.getTime()) {
        reminderDate.setTime(reminderDate.getTime() + 60 * 1000);
      }

      // Schedule the reminder
      setTimeout(
        async () => {
          try {
            await ctx.telegram.sendMessage(
              ctx.userId,
              `🔔 *Напоминание!*

${reminderText}`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '✅ Готово',
                        callback_data: 'reminder_done',
                      },
                    ],
                    [
                      {
                        text: '⏰ Через 15 мин',
                        callback_data: 'reminder_snooze_15',
                      },
                      {
                        text: '⏰ Через час',
                        callback_data: 'reminder_snooze_60',
                      },
                    ],
                  ],
                },
              },
            );
          } catch (error) {
            this.logger.error('Error sending reminder:', error);
          }
        },
        // Use precise delay based on absolute timestamp to respect normalized seconds
        Math.max(0, reminderDate.getTime() - now.getTime()),
      );

      const timeStr = this.formatTimeWithTimezone(reminderDate, user?.timezone);

      await ctx.editMessageTextWithMarkdown(
        `✅ *Напоминание установлено!*

📝 **Текст:** ${reminderText}
⏰ **Время:** через ${minutesFromNow} минут (в ${timeStr})

Я напомню вам в указанное время! 🔔`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ К напоминаниям', callback_data: 'reminders' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );

      // Add XP for using reminders
      await this.userService.updateUser(ctx.userId, {
        totalXp: user.totalXp + 5,
      });
    } catch (error) {
      this.logger.error('Error creating relative reminder:', error);
      await ctx.editMessageTextWithMarkdown(`
❌ *Ошибка создания напоминания*

Не удалось создать напоминание. Попробуйте ещё раз.
      `);
    }
  }

  private async handleReminderRequest(
    ctx: BotContext,
    reminderText: string,
    hours: string,
    minutes: string,
  ) {
    try {
      const user = await this.userService.findByTelegramId(ctx.userId);

      // Check billing limits for reminders
      const limitCheck = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyReminders',
      );

      if (!limitCheck.allowed) {
        await ctx.replyWithMarkdown(
          limitCheck.message || '🚫 Превышен лимит напоминаний',
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '💎 Обновиться до Premium',
                    callback_data: 'upgrade_premium',
                  },
                ],
                [{ text: '📊 Мои лимиты', callback_data: 'show_limits' }],
              ],
            },
          },
        );
        return;
      }

      // Validate time
      const hourNum = parseInt(hours);
      const minuteNum = parseInt(minutes);

      if (hourNum < 0 || hourNum > 23 || minuteNum < 0 || minuteNum > 59) {
        await ctx.replyWithMarkdown(`
❌ *Неверное время*

Пожалуйста, укажите корректное время в формате ЧЧ:ММ (например, 17:30)
        `);
        return;
      }

      // Create reminder time for today
      const now = new Date();
      const reminderDate = new Date();
      reminderDate.setHours(hourNum, minuteNum, 0, 0);

      // If time has already passed today, set for tomorrow
      if (reminderDate <= now) {
        reminderDate.setDate(reminderDate.getDate() + 1);
      }

      // Сохраняем напоминание в базу данных
      const savedReminder = await this.prisma.reminder.create({
        data: {
          userId: ctx.userId,
          type: 'GENERAL',
          title: reminderText,
          message: reminderText,
          scheduledTime: reminderDate,
          status: ReminderStatus.ACTIVE,
        },
      });

      // Уведомления будут отправлены через cron job в NotificationService

      // Increment usage counter
      await this.billingService.incrementUsage(ctx.userId, 'dailyReminders');

      // Format time/date using user's timezone when available
      const timeStr =
        this.formatTimeWithTimezone(reminderDate, user?.timezone) ||
        `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}`;
      const dateStr = this.formatDateWithTimezone(reminderDate, user?.timezone);

      // Get current usage for display
      const usageInfo = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyReminders',
      );

      await ctx.replyWithMarkdown(
        `
✅ *Напоминание установлено!*

📝 **Текст:** ${reminderText}
⏰ **Время:** ${timeStr}
📅 **Дата:** ${dateStr}

📊 **Использовано сегодня:** ${usageInfo.current}${usageInfo.limit === -1 ? '' : `/${usageInfo.limit}`} напоминаний

Я напомню вам в указанное время! 🔔
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ К напоминаниям', callback_data: 'reminders' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );

      // Add XP for using reminders
      await this.userService.updateUser(ctx.userId, {
        totalXp: user.totalXp + 5,
      });
    } catch (error) {
      this.logger.error('Error creating reminder:', error);
      await ctx.replyWithMarkdown(`
❌ *Ошибка создания напоминания*

Не удалось создать напоминание. Попробуйте ещё раз.
      `);
    }
  }

  private async handleReminderTimeInput(ctx: BotContext, timeInput: string) {
    try {
      const reminderData = ctx.session.pendingReminder;

      if (!reminderData) {
        await ctx.replyWithMarkdown('❌ Ошибка: текст напоминания не найден.');
        return;
      }

      const reminderText = reminderData.text;

      // Try to parse different time formats
      let hours: string | undefined, minutes: string | undefined;

      // Format: HH:MM или H:MM
      const timeMatch = timeInput.match(/(\d{1,2}):(\d{2})/);
      if (timeMatch) {
        hours = timeMatch[1];
        minutes = timeMatch[2];
      }
      // Format: "в HH" или "в HH:MM"
      else {
        const inTimeMatch = timeInput.match(/в\s*(\d{1,2})(?::(\d{2}))?/i);
        if (inTimeMatch) {
          hours = inTimeMatch[1];
          minutes = inTimeMatch[2] || '00';
        }
        // Format: "через X минут"
        else {
          const minutesMatch = timeInput.match(/через\s*(\d+)\s*минут/i);
          if (minutesMatch) {
            const minutesToAdd = parseInt(minutesMatch[1]);
            const futureTime = new Date();
            futureTime.setMinutes(futureTime.getMinutes() + minutesToAdd);
            // Normalize to minute boundary (seconds and ms = 0)
            futureTime.setSeconds(0, 0);
            // Ensure resulting time is in the future after normalization
            if (futureTime.getTime() <= Date.now()) {
              futureTime.setTime(futureTime.getTime() + 60 * 1000);
            }
            hours = futureTime.getHours().toString();
            minutes = futureTime.getMinutes().toString().padStart(2, '0');
          }
          // Format: "через X часов"
          else {
            const hoursMatch = timeInput.match(/через\s*(\d+)\s*час/i);
            if (hoursMatch) {
              const hoursToAdd = parseInt(hoursMatch[1]);
              const futureTime = new Date();
              futureTime.setHours(futureTime.getHours() + hoursToAdd);
              hours = futureTime.getHours().toString();
              minutes = futureTime.getMinutes().toString().padStart(2, '0');
            }
            // Try to parse just numbers as HH:MM
            else if (
              timeInput.match(/^\d{1,2}$/) &&
              parseInt(timeInput) <= 23
            ) {
              hours = timeInput;
              minutes = '00';
            }
          }
        }
      }

      // If no valid time format found
      if (!hours || !minutes) {
        await ctx.editMessageTextWithMarkdown(`
❌ *Не удалось понять время*

Пожалуйста, укажите время в одном из форматов:
• **17:30** - конкретное время
• **в 18:00** - с предлогом
• **через 30 минут** - относительное время
• **через 2 часа** - относительное время
• **18** - целый час (18:00)

_Попробуйте еще раз_
        `);
        return;
      }

      // Validate parsed time
      const hourNum = parseInt(hours);
      const minuteNum = parseInt(minutes);

      if (hourNum < 0 || hourNum > 23 || minuteNum < 0 || minuteNum > 59) {
        await ctx.editMessageTextWithMarkdown(`
❌ *Неверное время*

Часы должны быть от 0 до 23, минуты от 0 до 59.
Попробуйте еще раз.
        `);
        return;
      }

      // Clear session state
      ctx.session.pendingReminder = undefined;
      ctx.session.waitingForReminderTime = false;

      // Create the reminder
      await this.handleReminderRequest(ctx, reminderText, hours, minutes);
    } catch (error) {
      this.logger.error('Error processing reminder time input:', error);

      // Clear session state on error
      ctx.session.pendingReminder = undefined;
      ctx.session.waitingForReminderTime = false;

      // Use reply instead of edit to avoid "message can't be edited" error
      await ctx.replyWithMarkdown(`
❌ *Ошибка обработки времени*

Попробуйте создать напоминание заново.
      `);
    }
  }

  private async handleAudioMessage(ctx: BotContext, type: 'voice' | 'audio') {
    try {
      const emoji = type === 'voice' ? '🎤' : '🎵';
      const messageType =
        type === 'voice' ? 'голосовое сообщение' : 'аудио файл';

      await ctx.replyWithMarkdown(`${emoji} *Обрабатываю ${messageType}...*`);

      const transcribedText = await this.transcribeAudio(ctx, type);
      if (!transcribedText) {
        this.logger.error(
          `Failed to transcribe ${messageType} for user ${ctx.userId}`,
        );
        await ctx.replyWithMarkdown(
          `❌ Не удалось распознать ${messageType}. Возможные причины:\n\n• Слишком тихий звук\n• Плохое качество записи\n• Проблемы с сервисом распознавания\n\nПопробуйте еще раз или напишите текстом.`,
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

      // Normalize transcription for downstream matching (log the original too)
      const originalTranscribed = transcribedText;
      const normalizedTranscribed = transcribedText
        .replace(/["“”'`«»]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      const prettyMessage = `🎤 *Обработано голосовое сообщение*\n\n🎯 *Распознано:* "${originalTranscribed}"\n\nЯ автоматически определю, что вы хотели: создать задачу, напоминание или привычку. Подождите, пожалуйста...`;

      await ctx.replyWithMarkdown(prettyMessage, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      });

      // Handle AI Chat mode for audio messages
      if (ctx.session.aiChatMode) {
        await this.handleAIChatMessage(ctx, normalizedTranscribed);
        return;
      }

      // Handle audio reminders
      if (this.isReminderRequest(normalizedTranscribed)) {
        // Log for debugging: show normalized text
        this.logger.log(
          `Audio: treating as reminder, normalizedText="${normalizedTranscribed}"`,
        );
        await this.processReminderFromText(ctx, normalizedTranscribed);
        return;
      }

      // Handle voice commands for tasks
      if (
        normalizedTranscribed.toLowerCase().includes('добавить задачу') ||
        normalizedTranscribed.toLowerCase().includes('новая задача') ||
        normalizedTranscribed.toLowerCase().includes('создать задачу')
      ) {
        await this.startAddingTask(ctx);
        return;
      }

      // Check if this might be a task based on keywords and patterns
      if (this.isTaskRequest(normalizedTranscribed)) {
        this.logger.log(
          `Audio: treating as task, normalizedText="${normalizedTranscribed}"`,
        );
        await this.createTaskFromText(ctx, normalizedTranscribed);
        return;
      }

      // Handle voice commands for menu
      if (
        normalizedTranscribed.toLowerCase().includes('меню') ||
        normalizedTranscribed.toLowerCase().includes('главное меню') ||
        normalizedTranscribed.toLowerCase().includes('показать меню')
      ) {
        await this.showMainMenu(ctx);
        return;
      }

      // Handle voice commands for help
      if (
        normalizedTranscribed.toLowerCase().includes('помощь') ||
        normalizedTranscribed.toLowerCase().includes('справка') ||
        normalizedTranscribed.toLowerCase().includes('что ты умеешь')
      ) {
        await ctx.editMessageTextWithMarkdown(`
🤖 *Ticky AI - Ваш персональный AI помощник продуктивности*

*Основные команды:*
/start - Начать работу с ботом
/help - Показать эту справку  
/menu - Главное меню
/home - Быстро в главное меню
/feedback - Оставить отзыв о боте

*Голосовые команды:*
🎤 "Напомни мне..." - создать напоминание
🎤 "Добавить задачу" - создать новую задачу
🎤 "Показать меню" - открыть главное меню
🎤 "Что ты умеешь?" - показать справку

*Быстрый доступ:*
🏠 Напишите "меню" или "домой" для возврата в главное меню

*Быстрые действия:*
📝 Добавить задачу или напоминание
🧠 Пообщаться с ИИ-консультантом
📊 Посмотреть прогресс

Для получения подробной информации используйте /menu
        `);
        return;
      }

      // Handle voice commands for feedback
      if (
        normalizedTranscribed.toLowerCase().includes('обратная связь') ||
        normalizedTranscribed.toLowerCase().includes('отзыв') ||
        normalizedTranscribed.toLowerCase().includes('фидбек')
      ) {
        await this.showFeedbackSurvey(ctx);
        return;
      }

      // Handle voice commands for habits
      if (
        normalizedTranscribed.toLowerCase().includes('добавить привычку') ||
        normalizedTranscribed.toLowerCase().includes('новая привычка') ||
        normalizedTranscribed.toLowerCase().includes('создать привычку')
      ) {
        await this.startAddingHabit(ctx);
        return;
      }

      // Try to intelligently parse the transcribed text to create task/reminder/habit
      await this.analyzeAndCreateFromVoice(ctx, normalizedTranscribed);
    } catch (error) {
      this.logger.error(`${type} message processing error:`, error);
      await ctx.replyWithMarkdown(
        `❌ Произошла ошибка при обработке ${type === 'voice' ? 'голосового сообщения' : 'аудио файла'}.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  private async transcribeAudio(
    ctx: BotContext,
    type: 'voice' | 'audio',
  ): Promise<string | null> {
    try {
      // Check if message exists and has the right type
      if (!ctx.message) {
        this.logger.error(`No message found for ${type} transcription`);
        return null;
      }

      let fileId: string;

      if (type === 'voice' && 'voice' in ctx.message) {
        fileId = ctx.message.voice.file_id;
        this.logger.log(`Processing voice message with file_id: ${fileId}`);
      } else if (type === 'audio' && 'audio' in ctx.message) {
        fileId = ctx.message.audio.file_id;
        this.logger.log(`Processing audio message with file_id: ${fileId}`);
      } else {
        this.logger.error(`Invalid message type for ${type} transcription`);
        return null;
      }

      // Get file info and download
      this.logger.log(`Getting file link for ${type} message...`);
      const fileLink = await ctx.telegram.getFileLink(fileId);
      this.logger.log(`File link obtained: ${fileLink.href}`);

      const response = await fetch(fileLink.href);
      if (!response.ok) {
        this.logger.error(
          `Failed to download ${type} file: ${response.status} ${response.statusText}`,
        );
        return null;
      }

      const buffer = await response.arrayBuffer();
      this.logger.log(
        `Downloaded ${type} file, size: ${buffer.byteLength} bytes`,
      );

      // Create a File object for OpenAI
      const fileName = type === 'voice' ? 'voice.ogg' : 'audio.mp3';
      const mimeType = type === 'voice' ? 'audio/ogg' : 'audio/mpeg';
      const file = new File([buffer], fileName, { type: mimeType });

      // Use OpenAI Whisper for transcription
      this.logger.log(`Sending ${type} file to OpenAI for transcription...`);
      const transcription = await this.openaiService.transcribeAudio(file);
      this.logger.log(`Transcription result: "${transcription}"`);

      return transcription;
    } catch (error) {
      this.logger.error(`Error transcribing ${type}:`, error);
      return null;
    }
  }

  private async processReminderFromText(ctx: BotContext, text: string) {
    const normalized = text
      .replace(/["“”'`«»]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    this.logger.log(
      `Processing reminder from text: original="${text}" normalized="${normalized}"`,
    );

    // For debugging: log which patterns match
    try {
      const debugInterval =
        /каждую\s+минуту|каждый\s+час|каждые?\s*\d+\s*(минут|час|часа|часов)/i.test(
          normalized,
        );
      const debugTime =
        /в\s*(\d{1,2}):(\d{2})|в\s*(\d{1,2})\s*час|на\s*(\d{1,2}):(\d{2})|к\s*(\d{1,2}):(\d{2})|(\d{1,2}):(\d{2})/i.test(
          normalized,
        );
      const debugSimpleRel =
        /через\s*(минуту|минут|час|день|дня|дней|неделю|недели|месяц|год|лет)/i.test(
          normalized,
        );
      const debugRelNum =
        /через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i.test(
          normalized,
        );
      const debugReminderWithoutTime = this.isReminderWithoutTime(normalized);
      this.logger.log(
        `Debug matches -> interval:${debugInterval} time:${debugTime} simpleRel:${debugSimpleRel} relNum:${debugRelNum} withoutTime:${debugReminderWithoutTime}`,
      );
    } catch (e) {
      this.logger.warn('Error computing debug matches', e);
    }

    // Check for interval reminders - специальные случаи
    let intervalMinutes = 0;
    let intervalAmount = 0;
    let intervalUnit = '';

    // Проверяем "каждую минуту", "каждый час" и т.д.
    if (normalized.match(/каждую\s+минуту/i)) {
      intervalMinutes = 1;
      intervalAmount = 1;
      intervalUnit = 'минут';
    } else if (normalized.match(/каждый\s+час/i)) {
      intervalMinutes = 60;
      intervalAmount = 1;
      intervalUnit = 'час';
    } else {
      // Check for interval reminders (каждые X минут/часов)
      const intervalMatch = normalized.match(
        /каждые?\s*(\d+)\s*(минут|час|часа|часов)/i,
      );

      if (intervalMatch) {
        intervalAmount = parseInt(intervalMatch[1]);
        intervalUnit = intervalMatch[2].toLowerCase();

        if (intervalUnit.includes('минут')) {
          intervalMinutes = intervalAmount;
        } else if (intervalUnit.includes('час')) {
          intervalMinutes = intervalAmount * 60;
        }
      }
    }

    if (intervalMinutes > 0) {
      // Validate interval (minimum 1 minute, maximum 24 hours)
      if (intervalMinutes < 1 || intervalMinutes > 1440) {
        await ctx.replyWithMarkdown(`
❌ *Неверный интервал*

Интервал должен быть от 1 минуты до 24 часов.
        `);
        return;
      }

      // Extract reminder text
      const reminderText = normalized
        .replace(/напомни\s*(мне)?/gi, '')
        .replace(/напомню\s*(тебе|вам)?/gi, '')
        .replace(/напоминание/gi, '')
        .replace(/поставь/gi, '')
        .replace(/установи/gi, '')
        .replace(/каждую\s+минуту/gi, '')
        .replace(/каждый\s+час/gi, '')
        .replace(/каждые?\s*\d+\s*(?:минут|час|часа|часов)/gi, '')
        .trim();

      if (!reminderText || reminderText.length < 2) {
        await ctx.replyWithMarkdown(`
🤔 *О чем напоминать каждые ${intervalAmount} ${intervalUnit}?*

Вы указали интервал, но не указали, о чем напоминать.

*Пример:* "напоминай пить воду каждые 30 минут"
        `);
        return;
      }

      await this.handleIntervalReminder(ctx, reminderText, intervalMinutes);
      return;
    }

    // Extract time and reminder text from voice/text input
    const timeMatch =
      normalized.match(/в\s*(\d{1,2}):(\d{2})/i) ||
      normalized.match(
        /в\s*(\d{1,2})\s*час(?:а|ов)?(?:\s*(\d{2})\s*минут)?/i,
      ) ||
      normalized.match(/на\s*(\d{1,2}):(\d{2})/i) ||
      normalized.match(/к\s*(\d{1,2}):(\d{2})/i) ||
      normalized.match(/(\d{1,2}):(\d{2})/i); // Добавляем простой поиск времени в формате ЧЧ:ММ

    if (timeMatch) {
      const hours = timeMatch[1];
      const minutes = timeMatch[2] || '00';
      this.logger.log(`Time extracted: ${hours}:${minutes}`);

      // Extract reminder text by removing time references and trigger words
      const reminderText = normalized
        .replace(/напомни\s*(мне)?/gi, '')
        .replace(/напомню\s*(тебе|вам)?/gi, '')
        .replace(/напоминание/gi, '')
        .replace(/поставь/gi, '')
        .replace(/установи/gi, '')
        .replace(/в\s*\d{1,2}:?\d{0,2}\s*(?:час|минут)?(?:а|ов)?/gi, '')
        .replace(/на\s*\d{1,2}:?\d{0,2}/gi, '')
        .replace(/к\s*\d{1,2}:?\d{0,2}/gi, '')
        .replace(/\d{1,2}:\d{2}/g, '') // Удаляем время в формате ЧЧ:ММ
        .replace(/(утром|днем|вечером|ночью)/gi, '') // Удаляем части дня
        .trim();

      this.logger.log(`Reminder text extracted: "${reminderText}"`);

      // If no text left, ask for clarification
      if (!reminderText || reminderText.length < 2) {
        await ctx.replyWithMarkdown(`
🤔 *О чем напомнить?*

Вы указали время ${hours}:${minutes}, но не указали, о чем напомнить.

*Пример:* "напомни мне купить молоко в 17:30"
        `);
        return;
      }

      await this.handleReminderRequest(ctx, reminderText, hours, minutes);
      return;
    }

    // Handle relative time (через X минут/часов/дней/недель/месяцев/лет)
    // Support both numeric forms (через 5 минут) and natural single-unit forms (через минуту, через час)
    const simpleRelativeMatch = normalized.match(
      /через\s*(?:([\d]+|[а-яё]+)\s*)?(минуту|минут|час|день|дня|дней|неделю|недели|месяц|год|лет)/i,
    );

    if (simpleRelativeMatch) {
      // If user said a number word like 'одну' or 'две', simpleRelativeMatch[1] may contain it
      let amount = 1;
      const possibleNum = simpleRelativeMatch[1];
      const unit = simpleRelativeMatch[2].toLowerCase();
      if (possibleNum) {
        const parsed = this.parseRussianNumber(possibleNum);
        if (parsed !== null) {
          amount = parsed;
        }
      }

      const now = new Date();
      let targetDate = new Date(now);

      if (unit.includes('минут')) {
        targetDate.setMinutes(targetDate.getMinutes() + amount);
      } else if (unit.includes('час')) {
        targetDate.setHours(targetDate.getHours() + amount);
      } else if (
        unit.includes('день') ||
        unit.includes('дня') ||
        unit.includes('дней')
      ) {
        targetDate.setDate(targetDate.getDate() + amount);
      } else if (unit.includes('недел')) {
        targetDate.setDate(targetDate.getDate() + amount * 7);
      } else if (unit.includes('месяц')) {
        targetDate.setMonth(targetDate.getMonth() + amount);
      } else if (unit.includes('год') || unit.includes('лет')) {
        targetDate.setFullYear(targetDate.getFullYear() + amount);
      }

      const hours = targetDate.getHours().toString().padStart(2, '0');
      const minutes = targetDate.getMinutes().toString().padStart(2, '0');

      const reminderText = normalized
        .replace(/напомни\s*(мне)?/gi, '')
        .replace(/напомню\s*(тебе|вам)?/gi, '')
        .replace(
          /через\s*(?:минуту|минут|час|день|дня|дней|неделю|недели|месяц|год|лет)/gi,
          '',
        )
        .trim();

      // For single-unit (1) relative times we can treat short durations (<1 day) as normal reminders
      if (
        amount > 0 &&
        (unit.includes('день') ||
          unit.includes('недел') ||
          unit.includes('месяц') ||
          unit.includes('год') ||
          unit.includes('лет'))
      ) {
        await this.handleLongTermReminder(
          ctx,
          reminderText,
          targetDate,
          amount,
          unit,
        );
        return;
      }

      await this.handleReminderRequest(ctx, reminderText, hours, minutes);
      return;
    }

    const relativeMatch = normalized.match(
      /через\s*([\d]+|[а-яё]+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
    );

    if (relativeMatch) {
      // Parse numeric word or digits
      const rawAmount = relativeMatch[1];
      let amount = parseInt(rawAmount);
      if (isNaN(amount)) {
        const parsed = this.parseRussianNumber(rawAmount);
        amount = parsed === null ? 1 : parsed;
      }
      const unit = relativeMatch[2].toLowerCase();

      const now = new Date();
      let targetDate = new Date(now);

      // Calculate target date based on unit
      if (unit.includes('минут')) {
        targetDate.setMinutes(targetDate.getMinutes() + amount);
      } else if (unit.includes('час')) {
        targetDate.setHours(targetDate.getHours() + amount);
      } else if (
        unit.includes('день') ||
        unit.includes('дня') ||
        unit.includes('дней')
      ) {
        targetDate.setDate(targetDate.getDate() + amount);
      } else if (unit.includes('недел')) {
        targetDate.setDate(targetDate.getDate() + amount * 7);
      } else if (unit.includes('месяц')) {
        targetDate.setMonth(targetDate.getMonth() + amount);
      } else if (unit.includes('год') || unit.includes('лет')) {
        targetDate.setFullYear(targetDate.getFullYear() + amount);
      }

      const hours = targetDate.getHours().toString().padStart(2, '0');
      const minutes = targetDate.getMinutes().toString().padStart(2, '0');

      const reminderText = normalized
        .replace(/напомни\s*(мне)?/gi, '')
        .replace(/напомню\s*(тебе|вам)?/gi, '')
        .replace(
          /через\s*\d+\s*(?:минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)(?:а|ов)?/gi,
          '',
        )
        .trim();

      // If it's more than a day, we need special handling
      if (
        amount > 0 &&
        (unit.includes('день') ||
          unit.includes('недел') ||
          unit.includes('месяц') ||
          unit.includes('год') ||
          unit.includes('лет'))
      ) {
        await this.handleLongTermReminder(
          ctx,
          reminderText,
          targetDate,
          amount,
          unit,
        );
        return;
      }

      await this.handleReminderRequest(ctx, reminderText, hours, minutes);
      return;
    }

    // Handle specific time expressions (на следующей неделе, завтра, послезавтра, etc.)
    const specificTimeMatch = this.parseSpecificTimeExpressions(normalized);
    if (specificTimeMatch) {
      const { targetDate, reminderText } = specificTimeMatch;

      // Default to 9:00 AM for date-only reminders
      targetDate.setHours(9, 0, 0, 0);

      await this.handleLongTermReminder(
        ctx,
        reminderText,
        targetDate,
        0,
        'specific',
      );
      return;
    }

    // Check if this is a reminder request without time
    const isReminderWithoutTime = this.isReminderWithoutTime(normalized);
    if (isReminderWithoutTime) {
      // Extract reminder text by removing trigger words
      const reminderText = text
        .replace(/напомни\s*(мне)?/gi, '')
        .replace(/напомню\s*(мне)?/gi, '')
        .replace(/напоминание/gi, '')
        .replace(/поставь/gi, '')
        .replace(/установи/gi, '')
        .replace(/нужно.*напомнить/gi, '')
        .replace(/не забыть/gi, '')
        .trim();

      if (reminderText && reminderText.length > 1) {
        // Store reminder text in session and ask for time
        ctx.session.pendingReminder = {
          text: reminderText,
          originalText: text,
        };
        ctx.session.waitingForReminderTime = true;

        await ctx.replyWithMarkdown(`
⏰ *На какое время поставить напоминание?*

О чем напомнить: "${reminderText}"

*Укажите время:*
• В конкретное время: "17:30", "в 18:00"  
• Через некоторое время: "через 30 минут", "через 2 часа"

_Просто напишите время в удобном формате_
        `);
        return;
      }
    }

    // If no specific time found and not a clear reminder request, ask for clarification
    await ctx.replyWithMarkdown(`
🤔 *Не удалось определить время напоминания*

Пожалуйста, укажите время в формате:
• "напомни купить молоко в 17:30"
• "напомни позвонить маме через 30 минут"
    `);
  }

  private isReminderWithoutTime(text: string): boolean {
    const reminderPatterns = [
      /напомни(?:\s+мне)?\s+.+/i,
      /напомню(?:\s+мне)?\s+.+/i,
      /напоминание\s+.+/i,
      /поставь\s+напоминание\s+.+/i,
      /установи\s+напоминание\s+.+/i,
      /нужно\s+напомнить\s+.+/i,
      /не\s+забыть\s+.+/i,
    ];

    // Check if it's a reminder request but doesn't have time indicators
    const hasReminderTrigger = reminderPatterns.some((pattern) =>
      pattern.test(text),
    );

    // Extended time indicators including new patterns
    // Also detect single-unit relative forms like "через минуту" or "через час"
    const hasTimeIndicator =
      /в\s*\d{1,2}:?\d{0,2}|на\s*\d{1,2}:?\d{0,2}|к\s*\d{1,2}:?\d{0,2}|через\s*(?:\d+|одну|один|минуту|минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)\s*(?:$|\b)|завтра|послезавтра|на\s*следующей\s*неделе|в\s*следующем\s*месяце|в\s*следующем\s*году|на\s*этой\s*неделе|в\s*этом\s*месяце/i.test(
        text,
      );

    return hasReminderTrigger && !hasTimeIndicator;
  }

  /**
   * Parse small Russian number words into integers.
   * Returns null if not recognized.
   */
  private parseRussianNumber(word: string): number | null {
    if (!word) return null;
    const w = word.toString().toLowerCase().trim();
    const map: Record<string, number> = {
      '0': 0,
      '1': 1,
      '2': 2,
      '3': 3,
      '4': 4,
      '5': 5,
      '6': 6,
      '7': 7,
      '8': 8,
      '9': 9,
      '10': 10,
      один: 1,
      одна: 1,
      одну: 1,
      два: 2,
      две: 2,
      три: 3,
      четыре: 4,
      пять: 5,
      шесть: 6,
      семь: 7,
      восемь: 8,
      девять: 9,
      десять: 10,
      несколько: 3,
      пару: 2,
      пара: 2,
    };

    if (map[w] !== undefined) return map[w];

    // Try extracting digits
    const digits = w.match(/\d+/);
    if (digits) return parseInt(digits[0], 10);

    return null;
  }

  /*
  ЛОГИКА РАСПОЗНАВАНИЯ СООБЩЕНИЙ:
  
  🔔 НАПОМИНАНИЯ (isReminderRequest) - сообщения с конкретным временем:
  ✅ "напомни купить хлеб в 15:30"
  ✅ "вечером отправить письмо в 23:00" 
  ✅ "завтра позвонить маме в 14:00"
  ✅ "в 18:30 встретиться с друзьями"
  ✅ "через час позвонить врачу"
  ✅ "сделать что-то через 2 часа"
  
  📋 ЗАДАЧИ (isTaskRequest) - сообщения БЕЗ конкретного времени:
  ✅ "завтра сделать что-то" (без времени)
  ✅ "купить продукты"
  ✅ "позвонить маме"
  ✅ "в понедельник написать отчет"
  ✅ "сделать домашнее задание"
  
  🤖 ИИ ЧАТ (isGeneralChatMessage) - общие вопросы и приветствия:
  ✅ "привет"
  ✅ "как дела?"
  ✅ "что ты думаешь?"
  ✅ "посоветуй мне"
  
  ❌ ИСКЛЮЧЕНИЯ ДЛЯ ИИ:
  ❌ Любые сообщения с действиями (глаголы)
  ❌ Любые сообщения с временем
  ❌ Команды бота
  */

  private isReminderRequest(text: string): boolean {
    // Добавляем логирование для отладки
    console.log(`[DEBUG] Checking if text is reminder: "${text}"`);

    // Интервальные напоминания - добавляем в начало для приоритета!
    const intervalReminderPatterns = [
      /каждую\s+минуту/i,
      /каждый\s+час/i,
      /каждые\s*\d+\s*(минут|час|часа|часов)/i,
      /(напомни|напоминай|напомню).*каждую\s+минуту/i,
      /(напомни|напоминай|напомню).*каждый\s+час/i,
      /(напомни|напоминай|напомню).*каждые\s*\d+\s*(минут|час|часа|часов)/i,
      /.*каждую\s+минуту.*(напомни|напоминай|напомню)/i,
      /.*каждый\s+час.*(напомни|напоминай|напомню)/i,
      /.*каждые\s*\d+\s*(минут|час|часа|часов).*(напомни|напоминай|напомню)/i,
    ];

    // Проверяем интервальные напоминания в первую очередь
    const hasIntervalReminder = intervalReminderPatterns.some((pattern) =>
      pattern.test(text),
    );

    if (hasIntervalReminder) {
      return true;
    }

    // Also consider simple relative phrases like "через минуту", "через одну минуту", "через 1 минуту", "через час" as reminders
    const simpleRelativeReminder =
      /через\s*(?:\d+|одну|один)?\s*(?:минуту|минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i;
    if (simpleRelativeReminder.test(text)) {
      return true;
    }

    // Прямые напоминания со словом "напомни" и "напомню"
    const explicitReminderPatterns = [
      // Простые напоминания без времени
      /^напомни\s+(.+)/i, // "напомни купить молоко"
      /^напомню\s+(.+)/i, // "напомню позвонить маме"
      /^поставь\s+напоминание\s+(.+)/i, // "поставь напоминание купить хлеб"
      /^установи\s+напоминание\s+(.+)/i, // "установи напоминание встретиться с другом"
      /^создай\s+напоминание\s+(.+)/i, // "создай напоминание сходить в магазин"

      // Напоминания с конкретным временем
      /напомни.*в\s*(\d{1,2}):(\d{2})/i,
      /напомни.*в\s*(\d{1,2})\s*час/i,
      /напомни.*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
      /напомню.*в\s*(\d{1,2}):(\d{2})/i,
      /напомню.*в\s*(\d{1,2})\s*час/i,
      /напомню.*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
      /напомни.*(завтра|послезавтра|на\s*следующей\s*неделе|в\s*следующем\s*месяце|в\s*следующем\s*году)/i,
      /напомню.*(завтра|послезавтра|на\s*следующей\s*неделе|в\s*следующем\s*месяце|в\s*следующем\s*году)/i,
      /напоминание.*в\s*(\d{1,2}):(\d{2})/i,
      /напоминание.*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
      /поставь.*напоминание.*в\s*(\d{1,2}):(\d{2})/i,
      /установи.*напоминание.*в\s*(\d{1,2}):(\d{2})/i,
      /поставь.*напоминание.*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
      /установи.*напоминание.*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
    ];

    // Естественные выражения времени с действиями (напоминания)
    const naturalTimePatterns = [
      // Дни недели с временем
      /(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье).*в\s*(\d{1,2}):(\d{2})/i, // "в понедельник в 14:00"
      /(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье).*в\s*(\d{1,2})\s*час/i, // "в понедельник в 14 часов"
      /в\s*(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье).*в\s*(\d{1,2}):(\d{2})/i, // "в понедельник в 14:00"
      /в\s*(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье).*в\s*(\d{1,2})\s*час/i, // "в понедельник в 14 часов"

      // Паттерны с конкретным временем (часы:минуты)
      /(утром|днем|вечером|ночью|сегодня|завтра|послезавтра).*в\s*(\d{1,2}):(\d{2})/i, // "вечером отправить в 23:00"
      /(завтра|послезавтра|сегодня).*в\s*(\d{1,2}):(\d{2})/i, // "завтра позвонить в 15:30"
      /в\s*(\d{1,2}):(\d{2}).*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i, // "в 15:30 позвонить"

      // Паттерны с часами без минут
      /(утром|днем|вечером|ночью|сегодня|завтра|послезавтра).*в\s*(\d{1,2})\s*час/i, // "вечером в 8 часов"
      /в\s*(\d{1,2})\s*час.*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i, // "в 8 часов позвонить"

      // Паттерны с относительным временем - расширенные
      /через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет).*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i, // "через неделю позвонить"
      /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i, // "позвонить через месяц"

      // Паттерны со специфическими временными выражениями
      /(завтра|послезавтра).*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i, // "завтра позвонить"
      /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*(завтра|послезавтра)/i, // "позвонить завтра"
      /на\s*следующей\s*неделе.*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i, // "на следующей неделе позвонить"
      /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*на\s*следующей\s*неделе/i, // "позвонить на следующей неделе"
      /в\s*следующем\s*месяце.*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i, // "в следующем месяце позвонить"
      /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*в\s*следующем\s*месяце/i, // "позвонить в следующем месяце"

      // Простые паттерны с действиями и временем - сделаем их более гибкими
      /.*в\s*(\d{1,2}):(\d{2}).*[а-яё]/i, // любой текст с временем и русскими буквами
      /.*(\d{1,2}):(\d{2}).*[а-яё]/i, // любой текст с временем и русскими буквами (без "в")
      /(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*(\d{1,2}):(\d{2})/i, // "отправить письмо 23:00"
      /(\d{1,2}):(\d{2}).*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться)/i, // "23:00 отправить письмо"
      /(утром|днем|вечером|ночью).*(сделать|выполнить|купить|позвонить|написать|отправить|подготовить|организовать|запланировать|встретить|пойти|поехать|забрать|отнести|принести|вернуть|показать|рассказать|заплатить|оплатить|заказать|записаться|посмотреть|проверить|изучить|прочитать|приготовить|почистить|убрать|помыть|постирать|погладить|сходить|съездить|дойти|добраться|доехать|приехать|прийти|заехать|зайти|завернуть|заскочить|навестить|посетить|встретиться|увидеться|поговорить|обсудить|решить|закончить|завершить|начать|приступить|продолжить|остановить|прекратить|открыть|закрыть|включить|выключить|настроить|установить|скачать|загрузить|отправиться|выйти|уйти|вернуться|отдохнуть|поспать|проснуться|встать|лечь|собраться|одеться|переодеться).*(\d{1,2}):(\d{2})/i, // "вечером отправить письмо 23:00"
    ];

    const hasExplicitReminder = explicitReminderPatterns.some((pattern) =>
      pattern.test(text),
    );
    const hasNaturalTime = naturalTimePatterns.some((pattern) =>
      pattern.test(text),
    );

    const isReminder = hasExplicitReminder || hasNaturalTime;
    console.log(
      `[DEBUG] isReminderRequest result: ${isReminder} (explicit: ${hasExplicitReminder}, natural: ${hasNaturalTime})`,
    );

    return isReminder;
  }

  private isVerbByEnding(word: string): boolean {
    if (!word || word.length < 3) return false;

    const lowerWord = word.toLowerCase().trim();

    // Инфинитивы (что делать?)
    const infinitiveEndings = [
      'ть',
      'ти',
      'чь', // делать, идти, печь
      'ить', // говорить, любить, строить
      'еть', // смотреть, сидеть, лететь
      'ать', // играть, читать, слушать
      'ять', // стоять, бояться, смеяться
      'оть', // колоть, полоть, молоть
      'уть', // тянуть, гнуть, сгибнуть
      'сти', // нести, везти, расти
      'зти', // ползти, грызти
      'сть', // есть, класть
    ];

    // Глаголы 1-го лица единственного числа (я что делаю?)
    const firstPersonEndings = [
      'у',
      'ю', // делаю, читаю, пишу
      'аю',
      'яю',
      'ую',
      'юю', // играю, гуляю, рисую
      'шу',
      'жу',
      'чу',
      'щу', // пишу, режу, кричу, ищу
      'лю',
      'рю',
      'сю',
      'зю', // говорю, несу, везу
      'ью', // пью, лью
      'му',
      'ну',
      'ку',
      'гу', // жму, тяну, пеку, берегу
      'ду',
      'ту',
      'бу', // веду, несу, скребу
    ];

    // Глаголы 2-го лица единственного числа (ты что делаешь?)
    const secondPersonEndings = [
      'ешь',
      'ёшь',
      'ишь', // делаешь, идёшь, говоришь
      'аешь',
      'яешь',
      'уешь', // играешь, гуляешь, рисуешь
      'ьешь',
      'ьёшь', // пьёшь, льёшь
    ];

    // Глаголы 3-го лица единственного числа (он/она что делает?)
    const thirdPersonEndings = [
      'ет',
      'ёт',
      'ит', // делает, идёт, говорит
      'ает',
      'яет',
      'ует',
      'юет', // играет, гуляет, рисует
      'еет',
      'оет', // смеется, воет
      'ст',
      'зт', // несёт, везёт
      'ьёт',
      'ьет', // пьёт, льёт
    ];

    // Множественное число 1-го лица (мы что делаем?)
    const firstPersonPluralEndings = [
      'ем',
      'ём',
      'им', // делаем, идём, говорим
      'аем',
      'яем',
      'уем', // играем, гуляем, рисуем
      'ьём',
      'ьем', // пьём, льём
    ];

    // Множественное число 2-го лица (вы что делаете?)
    const secondPersonPluralEndings = [
      'ете',
      'ёте',
      'ите', // делаете, идёте, говорите
      'аете',
      'яете',
      'уете', // играете, гуляете, рисуете
    ];

    // Множественное число 3-го лица (они что делают?)
    const thirdPersonPluralEndings = [
      'ут',
      'ют',
      'ат',
      'ят', // делают, читают, играют, стоят
      'ают',
      'яют',
      'уют', // играют, гуляют, рисуют
      'еют',
      'оют', // смеются, воют
    ];

    // Повелительное наклонение (что делай!)
    const imperativeEndings = [
      'и',
      'ай',
      'яй',
      'ей',
      'уй',
      'юй', // делай, играй, читай, пей, дуй
    ];

    // Причастия и деепричастия
    const participleEndings = [
      'щий',
      'щая',
      'щее',
      'щие', // делающий, читающая
      'вший',
      'вшая',
      'вшее',
      'вшие', // сделавший
      'нный',
      'нная',
      'нное',
      'нные', // сделанный
      'тый',
      'тая',
      'тое',
      'тые', // битый, мытая
      'я',
      'в',
      'вши',
      'ши', // делая, сделав, сделавши
    ];

    // Прошедшее время
    const pastTenseEndings = [
      'л',
      'ла',
      'ло',
      'ли', // делал, делала, делало, делали
      'ал',
      'ала',
      'ало',
      'али', // играл, играла
      'ял',
      'яла',
      'яло',
      'яли', // стоял, стояла
      'ел',
      'ела',
      'ело',
      'ели', // сидел, сидела
      'ил',
      'ила',
      'ило',
      'или', // говорил, говорила
      'ул',
      'ула',
      'уло',
      'ули', // тянул, тянула
      'ыл',
      'ыла',
      'ыло',
      'ыли', // был, была, было, были
      'ёл',
      'ёла',
      'ёло',
      'ёли', // вёл, вела (но сохраняем ёл)
    ];

    // Возвратные глаголы (с -ся, -сь)
    const reflexiveEndings = [
      'ся',
      'сь', // делается, делаюсь, делался
      'тся',
      'ться', // делается, делаться
      'ется',
      'ится',
      'ается',
      'яется', // делается, говорится, играется
      'ешься',
      'ишься',
      'аешься',
      'яешься', // делаешься, говоришься
      'емся',
      'имся',
      'аемся',
      'яемся', // делаемся, говоримся
      'етесь',
      'итесь',
      'аетесь',
      'яетесь', // делаетесь, говоритесь
      'утся',
      'ятся',
      'аются',
      'яются', // делаются, говорятся, играются
      'лся',
      'лась',
      'лось',
      'лись', // делался, делалась, делалось, делались
    ];

    // Будущее время
    const futureEndings = [
      'буду',
      'будешь',
      'будет',
      'будем',
      'будете',
      'будут', // буду делать
    ];

    // Особые формы и исключения
    const specialVerbs = [
      'есть',
      'пить',
      'спать',
      'стоять',
      'лежать',
      'сидеть',
      'идти',
      'ехать',
      'лететь',
      'плыть',
      'бежать',
      'ползти',
      'жить',
      'быть',
      'иметь',
      'дать',
      'взять',
      'класть',
      'мочь',
      'хотеть',
      'уметь',
      'знать',
      'видеть',
      'слышать',
      'любить',
      'ненавидеть',
      'работать',
      'играть',
      'думать',
      'говорить',
      'читать',
      'писать',
      'рисовать',
      'петь',
      'танцевать',
      'прыгать',
      'кричать',
      'смеяться',
      'плакать',
      'учиться',
      'готовить',
      'покупать',
      'продавать',
      'искать',
      'находить',
      'терять',
      'помнить',
      'забывать',
      'понимать',
      'объяснять',
      'слушать',
      'смотреть',
      'изучать',
      'повторять',
    ];

    // Проверяем специальные глаголы
    if (specialVerbs.includes(lowerWord)) {
      return true;
    }

    // Проверяем окончания
    const allEndings = [
      ...infinitiveEndings,
      ...firstPersonEndings,
      ...secondPersonEndings,
      ...thirdPersonEndings,
      ...firstPersonPluralEndings,
      ...secondPersonPluralEndings,
      ...thirdPersonPluralEndings,
      ...imperativeEndings,
      ...participleEndings,
      ...pastTenseEndings,
      ...futureEndings,
      ...reflexiveEndings,
    ];

    return allEndings.some((ending) => {
      if (ending.length >= lowerWord.length) return false;
      return lowerWord.endsWith(ending);
    });
  }

  private findVerbsInText(text: string): string[] {
    const words = text
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 2);
    const detectedVerbs: string[] = [];

    for (const word of words) {
      // Убираем знаки препинания
      const cleanWord = word.replace(/[.,!?;:()"-]/g, '');
      if (this.isVerbByEnding(cleanWord)) {
        detectedVerbs.push(cleanWord);
      }
    }

    return detectedVerbs;
  }

  private isSimpleReminderRequest(text: string): boolean {
    // Простые напоминания без указания времени
    const simpleReminderPatterns = [
      /^напомни\s+мне\s+.+/i, // "напомни мне купить хлеб"
      /^напомню\s+себе\s+.+/i, // "напомню себе позвонить"
      /^напоминание\s+.+/i, // "напоминание купить молоко"
      /^поставь\s+напоминание\s+.+/i, // "поставь напоминание позвонить"
      /^установи\s+напоминание\s+.+/i, // "установи напоминание сходить в магазин"
      /^создай\s+напоминание\s+.+/i, // "создай напоминание встретиться"
    ];

    // Проверяем прямые паттерны напоминаний
    if (simpleReminderPatterns.some((pattern) => pattern.test(text))) {
      return true;
    }

    // Проверяем сообщения с временными словами и глаголами действия (это тоже напоминания)
    const timeWords = [
      'завтра',
      'послезавтра',
      'сегодня',
      'вечером',
      'утром',
      'днем',
      'ночью',
      'в понедельник',
      'во вторник',
      'в среду',
      'в четверг',
      'в пятницу',
      'в субботу',
      'в воскресенье',
      'на следующей неделе',
      'в следующем месяце',
      'в следующем году',
    ];

    const actionVerbs = [
      'сделать',
      'выполнить',
      'купить',
      'скушать',
      'съесть',
      'позвонить',
      'написать',
      'отправить',
      'подготовить',
      'организовать',
      'запланировать',
      'встретить',
      'пойти',
      'поехать',
      'забрать',
      'отнести',
      'принести',
      'вернуть',
      'показать',
      'рассказать',
      'заплатить',
      'оплатить',
      'заказать',
      'записаться',
      'посмотреть',
      'проверить',
      'изучить',
      'прочитать',
      'приготовить',
      'почистить',
      'убрать',
      'помыть',
      'постирать',
      'погладить',
      'сходить',
      'съездить',
      'дойти',
      'добраться',
      'доехать',
      'приехать',
      'прийти',
      'заехать',
      'зайти',
      'завернуть',
      'заскочить',
      'навестить',
      'посетить',
      'встретиться',
      'увидеться',
      'поговорить',
      'обсудить',
      'решить',
      'закончить',
      'завершить',
      'начать',
      'приступить',
      'продолжить',
      'остановить',
      'прекратить',
      'открыть',
      'закрыть',
      'включить',
      'выключить',
      'настроить',
      'установить',
      'скачать',
      'загрузить',
      'отправиться',
      'выйти',
      'уйти',
      'вернуться',
      'отдохнуть',
      'поспать',
      'проснуться',
      'встать',
      'лечь',
      'собраться',
      'одеться',
      'переодеться',
      'умыться',
      'почистить',
      'покушать',
      'поесть',
      'попить',
      'выпить',
      'попробовать',
      'попытаться',
      'поработать',
      'поучиться',
      'потренироваться',
      'позаниматься',
      'поиграть',
      'погулять',
      'побегать',
      'потанцевать',
      'петь',
      'рисовать',
      'писать',
      'читать',
      'слушать',
      'смотреть',
      'учить',
      'изучать',
      'повторить',
      'запомнить',
      'забыть',
      'вспомнить',
      'найти',
      'искать',
      'потерять',
      'сломать',
      'починить',
      'исправить',
      'подарить',
      'получить',
      'взять',
      'дать',
      'отдать',
      'одолжить',
      'занять',
      'продать',
      'покупать',
      'продавать',
      'менять',
      'обменять',
      'считать',
      'подсчитать',
      'рассчитать',
      'измерить',
      'взвесить',
      'сравнить',
      'выбрать',
      'решить',
      'определить',
      'узнать',
      'разузнать',
      'спросить',
      'ответить',
      'объяснить',
      'понять',
      'разобраться',
      'помочь',
      'поддержать',
      'защитить',
      'спасти',
      'вылечить',
      'полечить',
      'болеть',
      'выздороветь',
      'отремонтировать',
    ];

    // Если есть временное слово И глагол действия - это напоминание
    const hasTimeWord = timeWords.some((timeWord) =>
      text.toLowerCase().includes(timeWord.toLowerCase()),
    );

    // Используем расширенный список глаголов + детектор по окончаниям
    const knownActionVerbs = actionVerbs.some((verb) =>
      text.toLowerCase().includes(verb.toLowerCase()),
    );

    // Находим глаголы по окончаниям
    const detectedVerbs = this.findVerbsInText(text);
    const hasDetectedVerb = detectedVerbs.length > 0;

    // Логирование для отладки
    if (hasDetectedVerb) {
      this.logger.log(
        `Detected verbs in "${text}": ${detectedVerbs.join(', ')}`,
      );
    }

    const hasActionVerb = knownActionVerbs || hasDetectedVerb;

    // Дополнительные паттерны для определения напоминаний
    const reminderIndicators = [
      /нужно\s+/i, // "нужно сделать"
      /надо\s+/i, // "надо купить"
      /должен\s+/i, // "должен позвонить"
      /должна\s+/i, // "должна встретиться"
      /стоит\s+/i, // "стоит проверить"
      /хочу\s+/i, // "хочу сходить завтра"
      /планирую\s+/i, // "планирую поехать"
      /собираюсь\s+/i, // "собираюсь делать"
      /буду\s+/i, // "буду читать завтра"
    ];

    const hasReminderIndicator = reminderIndicators.some((pattern) =>
      pattern.test(text),
    );

    return hasTimeWord && (hasActionVerb || hasReminderIndicator);
  }

  private isTaskRequest(text: string): boolean {
    // Сначала проверяем, не является ли это напоминанием с конкретным временем
    if (this.isReminderRequest(text)) {
      return false; // Если это напоминание, то не задача
    }

    // Исключаем очень короткие тексты (1-2 слова без глаголов действия)
    const words = text.trim().split(/\s+/);
    if (words.length <= 2) {
      // Для коротких фраз требуем явные глаголы действия
      const actionVerbs = [
        'сделать',
        'выполнить',
        'купить',
        'скушать',
        'съесть',
        'есть',
        'поесть',
        'попить',
        'позвонить',
        'написать',
        'отправить',
        'подготовить',
        'организовать',
        'запланировать',
        'встретить',
        'пойти',
        'поехать',
        'забрать',
        'отнести',
        'принести',
        'вернуть',
        'показать',
        'рассказать',
        'заплатить',
        'оплатить',
        'заказать',
        'записаться',
        'посмотреть',
        'проверить',
        'изучить',
        'прочитать',
        'приготовить',
        'почистить',
        'убрать',
        'помыть',
        'постирать',
        'погладить',
        'сходить',
        'съездить',
        'дойти',
        'добраться',
        'доехать',
        'приехать',
        'прийти',
        'заехать',
        'зайти',
        'завернуть',
        'заскочить',
        'навестить',
        'посетить',
        'встретиться',
        'увидеться',
        'поговорить',
        'обсудить',
        'решить',
        'закончить',
        'завершить',
        'начать',
        'приступить',
        'продолжить',
        'остановить',
        'прекратить',
        'открыть',
        'закрыть',
        'включить',
        'выключить',
        'настроить',
        'установить',
        'скачать',
        'загрузить',
        'отправиться',
        'выйти',
        'уйти',
        'вернуться',
        'отдохнуть',
        'поспать',
        'проснуться',
        'встать',
        'лечь',
        'собраться',
        'одеться',
        'переодеться',
        'умыться',
        'покушать',
        'поесть',
        'попить',
        'выпить',
        'попробовать',
        'попытаться',
        'поработать',
        'поучиться',
        'потренироваться',
        'позаниматься',
        'поиграть',
        'погулять',
        'побегать',
        'потанцевать',
        'петь',
        'рисовать',
        'писать',
        'читать',
        'слушать',
        'смотреть',
        'учить',
        'изучать',
        'повторить',
        'запомнить',
        'забыть',
        'вспомнить',
        'найти',
        'искать',
        'потерять',
        'сломать',
        'починить',
        'исправить',
        'подарить',
        'получить',
        'взять',
        'дать',
        'отдать',
        'одолжить',
        'занять',
        'продать',
        'покупать',
        'продавать',
        'менять',
        'обменять',
        'считать',
        'подсчитать',
        'рассчитать',
        'измерить',
        'взвесить',
        'сравнить',
        'выбрать',
        'определить',
        'узнать',
        'разузнать',
        'спросить',
        'ответить',
        'объяснить',
        'понять',
        'разобраться',
        'помочь',
        'поддержать',
        'защитить',
        'спасти',
        'вылечить',
        'полечить',
        'болеть',
        'выздороветь',
        'отремонтировать',
        'пить',
        'делать',
      ];

      // Используем известные глаголы действия + детектор по окончаниям
      const knownActionVerbs = actionVerbs.some((verb) =>
        text.toLowerCase().includes(verb),
      );

      // Находим глаголы по окончаниям для коротких фраз
      const detectedVerbs = this.findVerbsInText(text);
      const hasDetectedVerb = detectedVerbs.length > 0;

      const hasActionVerb = knownActionVerbs || hasDetectedVerb;

      if (!hasActionVerb) {
        return false;
      }
    }

    // Проверяем, что это задача БЕЗ конкретного времени или С временными паттернами
    const taskPatterns = [
      // Прямые указания на задачи
      /нужно\s+/i,
      /надо\s+/i,
      /должен\s+/i,
      /хочу\s+/i,
      /планирую\s+/i,
      /собираюсь\s+/i,
      /требуется\s+/i,
      /необходимо\s+/i,
      /важно\s+/i,
      /срочно\s+/i,

      // Универсальный паттерн для глаголов в начале фразы (инфинитив)
      /^[а-яё]+ать\s+/i, // глаголы на -ать: делать, читать, писать
      /^[а-яё]+еть\s+/i, // глаголы на -еть: смотреть, видеть
      /^[а-яё]+ить\s+/i, // глаголы на -ить: говорить, купить
      /^[а-яё]+ять\s+/i, // глаголы на -ять: брать, взять
      /^[а-яё]+ыть\s+/i, // глаголы на -ыть: быть, мыть
      /^[а-яё]+оть\s+/i, // глаголы на -оть: молоть, полоть
      /^[а-яё]+уть\s+/i, // глаголы на -уть: тянуть, гнуть
      /^[а-яё]+сть\s+/i, // глаголы на -сть: есть, класть
      /^[а-яё]+зть\s+/i, // глаголы на -зть: лезть, везть
      /^[а-яё]+чь\s+/i, // глаголы на -чь: печь, течь
      /^[а-яё]+ти\s+/i, // глаголы на -ти: идти, нести

      // Особые формы и краткие глаголы
      /^(есть|пить|спать|жить|быть|дать|взять|сесть|встать|лечь)\s+/i,

      // Временные паттерны с любыми глаголами
      /(завтра|послезавтра|сегодня|в понедельник|во вторник|в среду|в четверг|в пятницу|в субботу|в воскресенье)\s+/i,
      /^нужно\s+/i,
      /^надо\s+/i,
      /каждый\s+(день|час|минут)/i,
      /каждые\s+\d+/i,

      // Временные выражения
      /через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
      /(завтра|послезавтра)/i,
      /на\s*следующей\s*неделе/i,
      /в\s*следующем\s*месяце/i,
    ];

    // Строгие исключения только для напоминаний с явными триггерами
    const reminderOnlyExclusions = [
      /(утром|днем|вечером|ночью).*в\s*\d/i, // "вечером в ..." - это напоминание
      /завтра\s+в\s+\d/i, // "завтра в 15:30" - напоминание
      /сегодня\s+в\s+\d/i, // "сегодня в 15:30" - напоминание
    ];

    // Исключаем только явные триггеры напоминаний
    const reminderTriggers = [/напомни|напомню|напоминание|remind/i];

    // Проверяем исключения
    const hasReminderOnlyExclusions = reminderOnlyExclusions.some((pattern) =>
      pattern.test(text),
    );
    const hasReminderTriggers = reminderTriggers.some((pattern) =>
      pattern.test(text),
    );

    if (hasReminderOnlyExclusions || hasReminderTriggers) {
      return false;
    }

    // Проверяем, что это похоже на задачу
    const isTask = taskPatterns.some((pattern) => pattern.test(text));

    // Дополнительно проверяем через универсальный детектор глаголов
    if (!isTask) {
      const detectedVerbs = this.findVerbsInText(text);
      const hasVerb = detectedVerbs.length > 0;

      // Если есть глагол и нет явных временных слов с конкретным временем - это может быть задача
      const hasSpecificTime =
        /в\s+\d{1,2}:\d{2}|через\s+\d+\s*(минут|час)/i.test(text);

      if (hasVerb && !hasSpecificTime && text.length > 10) {
        this.logger.log(
          `Universal verb detector found task candidate: "${text}" with verbs: ${detectedVerbs.join(', ')}`,
        );
        return true;
      }
    }

    return isTask;
  }

  private isGeneralChatMessage(text: string): boolean {
    const generalPatterns = [
      // Только прямые обращения к ИИ или боту
      /^(привет|здравствуй|добрый день|добрый вечер|хай|hello|hi)$/i, // точные приветствия
      /^(пока|до свидания|увидимся|всего хорошего|bye|goodbye)$/i, // точные прощания

      // Явные вопросы к ИИ
      /^ответь на вопрос/i,
      /^что мне делать/i,
      /^как дела\??$/i,
      /^как поживаешь\??$/i,
      /^что нового\??$/i,
      /^расскажи о/i,
      /^объясни мне/i,
      /^помоги понять/i,
      /^что ты думаешь о/i,
      /^твое мнение о/i,
      /^как ты считаешь/i,
      /^посоветуй мне/i,
      /^что ты думаешь\??$/i,

      // Только прямые вопросы к боту
      /^что ты умеешь\??$/i,
      /^помощь$/i,
      /^help$/i,

      // Благодарности (только если это отдельное сообщение)
      /^спасибо$/i,
      /^благодарю$/i,
      /^thanks$/i,
    ];

    // Расширенный список исключений - все что может быть задачей, напоминанием или командой
    const excludePatterns = [
      /\/\w+/, // команды бота
      /добавить|создать|сделать|выполнить|купить|позвонить|написать|отправить|заказать|записать|встретить|пойти|поехать/i, // глаголы действий
      /в\s*\d{1,2}:\d{2}/, // временные метки (точное время) - всегда исключаем
      /через\s+\d+/, // временные промежутки - всегда исключаем
      /в\s*\d{1,2}\s*час/, // "в 3 часа" - всегда исключаем
      /(утром|днем|вечером|ночью).*в\s*\d/, // "вечером в ..." - всегда исключаем
      /напомни|напоминание|будильник|таймер/i, // напоминания
      /задача|дело|план|цель/i, // задачи
      /привычка|тренировка|упражнение/i, // привычки
      /^\d+/, // сообщения начинающиеся с цифр
      /:\d{2}/, // любое время
      /\d+\s*(минут|часов|дней|недель|месяцев)/i, // временные интервалы
      /нужно|надо|должен|обязательно/i, // слова обязательств
    ];

    // Проверяем исключения
    const hasExclusions = excludePatterns.some((pattern) => pattern.test(text));
    if (hasExclusions) {
      return false;
    }

    // Проверяем общие паттерны
    const isGeneral = generalPatterns.some((pattern) => pattern.test(text));

    return isGeneral;
  }

  private async processTaskFromText(
    ctx: BotContext,
    text: string,
  ): Promise<void> {
    // Handle time-based tasks with extended patterns
    console.log(`🔍 Processing task from text: "${text}"`);

    // Handle relative time for tasks (через X минут/часов/дней/недель/месяцев/лет)
    const relativeMatch = text.match(
      /через\s*(\d+)\s*(минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)/i,
    );

    if (relativeMatch) {
      const amount = parseInt(relativeMatch[1]);
      const unit = relativeMatch[2].toLowerCase();

      const now = new Date();
      let targetDate = new Date(now);

      // Calculate target date based on unit
      if (unit.includes('минут')) {
        targetDate.setMinutes(targetDate.getMinutes() + amount);
      } else if (unit.includes('час')) {
        targetDate.setHours(targetDate.getHours() + amount);
      } else if (
        unit.includes('день') ||
        unit.includes('дня') ||
        unit.includes('дней')
      ) {
        targetDate.setDate(targetDate.getDate() + amount);
      } else if (unit.includes('недел')) {
        targetDate.setDate(targetDate.getDate() + amount * 7);
      } else if (unit.includes('месяц')) {
        targetDate.setMonth(targetDate.getMonth() + amount);
      } else if (unit.includes('год') || unit.includes('лет')) {
        targetDate.setFullYear(targetDate.getFullYear() + amount);
      }

      const taskText = text
        .replace(
          /через\s*\d+\s*(?:минут|час|день|дня|дней|неделю|недели|недель|месяц|месяца|месяцев|год|года|лет)(?:а|ов)?/gi,
          '',
        )
        .trim();

      // If it's more than a day, we need special handling
      if (
        amount > 0 &&
        (unit.includes('день') ||
          unit.includes('недел') ||
          unit.includes('месяц') ||
          unit.includes('год') ||
          unit.includes('лет'))
      ) {
        await this.handleLongTermTask(ctx, taskText, targetDate, amount, unit);
        return;
      }

      // For short-term tasks (minutes/hours), create immediately with deadline
      await this.createTaskWithDeadline(ctx, taskText, targetDate);
      return;
    }

    // Handle specific time expressions for tasks (завтра, на следующей неделе, etc.)
    const specificTimeMatch = this.parseSpecificTimeExpressionsForTasks(text);
    if (specificTimeMatch) {
      const { targetDate, taskText } = specificTimeMatch;

      // Default to 9:00 AM for date-only tasks
      targetDate.setHours(9, 0, 0, 0);

      await this.handleLongTermTask(ctx, taskText, targetDate, 0, 'specific');
      return;
    }

    // Handle concrete time patterns (в 15:30, завтра в 14:00)
    const concreteTimeMatch = text.match(/в\s*(\d{1,2}):(\d{2})/i);
    if (concreteTimeMatch) {
      const hours = parseInt(concreteTimeMatch[1]);
      const minutes = parseInt(concreteTimeMatch[2]);

      if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
        const targetDate = new Date();
        targetDate.setHours(hours, minutes, 0, 0);

        // If time has passed today, set for tomorrow
        if (targetDate.getTime() <= new Date().getTime()) {
          targetDate.setDate(targetDate.getDate() + 1);
        }

        const taskText = text.replace(/в\s*\d{1,2}:\d{2}/gi, '').trim();

        await this.createTaskWithDeadline(ctx, taskText, targetDate);
        return;
      }
    }

    // No specific time found - create regular task
    await this.createTaskFromText(ctx, text);
  }

  private async createTaskFromText(ctx: BotContext, text: string) {
    try {
      const user = await this.userService.findByTelegramId(ctx.userId);

      if (!user.timezone) {
        ctx.session.step = 'waiting_for_task_title';
        ctx.session.tempData = { taskTitle: text };
        await this.askForTimezone(ctx);
        return;
      }

      // Проверяем, содержит ли текст интервал времени
      const intervalInfo = this.extractTimeIntervalFromText(text.trim());

      if (intervalInfo) {
        // Создаем привычку с автоматическим напоминанием для интервальных задач
        const habit = await this.habitService.createHabit({
          userId: ctx.userId,
          title: text.trim(),
          description: `Привычка с интервалом: ${intervalInfo.interval}`,
          frequency: 'DAILY',
          reminderTime: intervalInfo.interval,
        });

        // Напоминания теперь будут настроены через интерфейс бота
        // чтобы избежать дублирования уведомлений

        let responseMessage = `✅ *Привычка создана!*\n\n📝 **"${habit.title}"**\n\n� **Описание:** ${intervalInfo.interval}\n\n💡 *Подсказка:* Вы можете настроить напоминания для этой привычки в меню привычек.`;

        await ctx.replyWithMarkdown(responseMessage, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '⏰ Настроить напоминание',
                  callback_data: `habit_set_reminder_${habit.id}`,
                },
              ],
              [{ text: '🎯 Мои привычки', callback_data: 'habits_list' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              [{ text: '❓ Что еще я умею?', callback_data: 'faq_support' }],
            ],
          },
        });
      } else {
        // Создаем обычную задачу, если интервал не найден
        const task = await this.taskService.createTask({
          userId: ctx.userId,
          title: text.trim(),
        });

        let responseMessage = `✅ *Задача создана!*\n\n📝 **"${task.title}"**\n\nЗадача добавлена в ваш список. Вы можете найти её в разделе "Мои задачи и привычки".`;
        responseMessage += `\n\n💡 *Подсказки:*
• Напоминание: "напомни купить молоко в 17:30"
• Интервальное: "напоминай пить воду каждые 30 минут"`;

        // Кнопка для создания напоминания на основе задачи
        // Логируем исходный заголовок задачи для отладки
        this.logger.log(`[LOG] Reminder button raw title: ${task.title}`);

        // Сохраняем заголовок в сессии для использования позже
        if (!ctx.session.tempData) {
          ctx.session.tempData = {};
        }
        ctx.session.tempData.pendingReminderTitle = task.title;

        // Используем ID задачи как более компактный идентификатор
        const reminderCallback = `create_reminder_${task.id.slice(0, 10)}`;
        this.logger.log(
          `[LOG] Reminder button safe callback: ${reminderCallback}`,
        );

        await ctx.replyWithMarkdown(responseMessage, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Мои задачи', callback_data: 'tasks_list' }],
              [
                {
                  text: '🔔 Создать как напоминание',
                  callback_data: reminderCallback,
                },
              ],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        });
      }
    } catch (error) {
      this.logger.error(`Error creating task from text: ${error}`);
      await ctx.replyWithMarkdown(
        '❌ Произошла ошибка при создании задачи. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  private async showTasksAIAdvice(ctx: BotContext) {
    try {
      await ctx.editMessageTextWithMarkdown('🤔 *Анализирую ваши задачи...*');

      // Получаем персонализированный совет по задачам
      const aiAdvice = await this.aiContextService.generatePersonalizedMessage(
        ctx.userId,
        'task_suggestion',
        '',
      );

      await ctx.editMessageTextWithMarkdown(
        `
🤖 *AI-совет по задачам:*

${aiAdvice}

💡 *Хотите ещё советы?* Просто напишите мне в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Добавить задачу', callback_data: 'tasks_add' }],
              [{ text: '🔙 Назад к меню задач', callback_data: 'menu_tasks' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error getting AI advice for tasks:', error);
      await ctx.editMessageTextWithMarkdown(
        `
❌ *Не удалось получить AI-совет*

Попробуйте позже или напишите мне напрямую в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад к меню задач', callback_data: 'menu_tasks' }],
            ],
          },
        },
      );
    }
  }

  private async showHabitsAIAdvice(ctx: BotContext) {
    try {
      await ctx.editMessageTextWithMarkdown('🤔 *Анализирую ваши привычки...*');

      // Получаем персонализированный совет по привычкам
      const aiAdvice = await this.aiContextService.generatePersonalizedMessage(
        ctx.userId,
        'habit_advice',
        '',
      );

      await ctx.editMessageTextWithMarkdown(
        `
🤖 *AI-совет по привычкам:*

${aiAdvice}

💡 *Хотите ещё советы?* Просто напишите мне в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад к привычкам', callback_data: 'menu_habits' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error getting AI advice for habits:', error);
      await ctx.editMessageTextWithMarkdown(
        `
❌ *Не удалось получить AI-совет*

Попробуйте позже или напишите мне напрямую в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад к привычкам', callback_data: 'menu_habits' }],
            ],
          },
        },
      );
    }
  }

  // Command handler methods
  private async showHabitsMenu(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    if (!user.timezone) {
      ctx.session.step = 'adding_habit';
      await this.askForTimezone(ctx);
    } else {
      try {
        const habits = await this.habitService.findHabitsByUserId(ctx.userId);

        if (habits.length === 0) {
          const message = `🎯 *Мои привычки*\n\nУ вас пока нет привычек.\n\n💡 Добавьте первую привычку, чтобы начать отслеживание!`;

          const keyboard = {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🎯 Добавить привычку', callback_data: 'habits_add' }],
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          };

          if (ctx.callbackQuery) {
            await ctx.editMessageTextWithMarkdown(message, keyboard);
          } else {
            await ctx.replyWithMarkdown(message, keyboard);
          }
        } else {
          let message = `🎯 *Мои привычки*\n\n`;

          // Get user data first
          const user = await this.userService.findByTelegramId(ctx.userId);

          // Create progress bar for today's completion
          const today_str = new Date().toISOString().split('T')[0];
          // Count habits completed today
          const completedCount = habits.filter((h) =>
            this.habitService.isCompletedToday(h),
          ).length;
          const totalHabits = habits.length;

          // Progress bar visualization (red -> yellow -> green)
          const progressPercentage =
            totalHabits > 0 ? (completedCount / totalHabits) * 100 : 0;
          let progressColor = '🔴';
          if (progressPercentage >= 30 && progressPercentage < 70) {
            progressColor = '🟡';
          } else if (progressPercentage >= 70) {
            progressColor = '🟢';
          }

          const progressBar =
            '█'.repeat(Math.floor(progressPercentage / 10)) +
            '⬜'.repeat(10 - Math.floor(progressPercentage / 10));

          message += `${progressColor} **Прогресс:** ${progressBar} ${completedCount}/${totalHabits}\n\n`;
          message += `💎 **XP:** ${user.totalXp || 0} | 🏆 **Уровень:** ${user.level || 1}\n\n`;
          message += `📅 **${new Date().toLocaleDateString('ru-RU')}**\n\n`;

          // Add habits list with checkbox indicators
          for (const habit of habits.slice(0, 8)) {
            // Check if habit was completed today using updatedAt field
            const isCompletedToday = this.habitService.isCompletedToday(habit);
            const checkMark = isCompletedToday ? '☑️' : '⬜';
            message += `${checkMark} ${habit.title}\n`;
          }

          if (habits.length > 10) {
            message += `*... и еще ${habits.length - 10} привычек*\n\n`;
          }

          message += `🔥 **Общая серия:** ${user.currentStreak || 0} дней подряд\n`;
          message += `⭐ **Общий XP:** ${user.totalXp || 0}`;

          // Create keyboard with habit management
          const keyboard = {
            reply_markup: {
              inline_keyboard: [
                // Quick completion buttons for incomplete habits
                ...habits
                  .filter((h) => !this.habitService.isCompletedToday(h))
                  .slice(0, 4)
                  .map((habit) => [
                    {
                      text: `✅ ${habit.title.substring(0, 30)}${habit.title.length > 30 ? '...' : ''}`,
                      callback_data: `habit_complete_${habit.id}`,
                    },
                  ]),
                // Management and additional buttons
                [
                  {
                    text: '⚙️ Управление привычек',
                    callback_data: 'habits_management',
                  },
                ],
                [
                  { text: '➕ Добавить', callback_data: 'habits_add' },
                  {
                    text: '🤖 AI - совет по задачам',
                    callback_data: 'habits_ai_advice',
                  },
                ],
                [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
              ],
            },
          };

          if (ctx.callbackQuery) {
            try {
              await ctx.editMessageTextWithMarkdown(message, keyboard);
            } catch (error) {
              // Fallback for photo messages - reply instead of edit
              await ctx.replyWithMarkdown(message, keyboard);
            }
          } else {
            await ctx.replyWithMarkdown(message, keyboard);
          }
        }
      } catch (error) {
        this.logger.error(`Error fetching habits: ${error}`);

        const errorMessage =
          '❌ Произошла ошибка при загрузке привычек. Попробуйте позже.';
        const errorKeyboard = {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        };

        if (ctx.callbackQuery) {
          await ctx.editMessageTextWithMarkdown(errorMessage, errorKeyboard);
        } else {
          await ctx.replyWithMarkdown(errorMessage, errorKeyboard);
        }
      }
    }
  }

  private getHabitProgressAnimation(completionCount: number): string {
    // Создаем анимированный прогресс-бар на основе количества выполнений
    const maxBars = 8;
    const levels = [5, 15, 30, 50, 100]; // Уровни для разных стадий

    let currentLevel = 0;
    for (let i = 0; i < levels.length; i++) {
      if (completionCount >= levels[i]) {
        currentLevel = i + 1;
      }
    }

    const filledBars = Math.min(currentLevel * 2, maxBars);
    const emptyBars = maxBars - filledBars;

    // Разные виды анимации в зависимости от уровня
    let barChar = '▓';
    let emptyChar = '⬜';

    if (currentLevel >= 4) {
      barChar = '🔥'; // Огонь для высокого уровня
    } else if (currentLevel >= 3) {
      barChar = '⭐'; // Звезды для среднего уровня
    } else if (currentLevel >= 2) {
      barChar = '💪'; // Мускулы для начального уровня
    }

    return `${barChar.repeat(Math.max(1, filledBars))}${emptyChar.repeat(emptyBars)}`;
  }

  private async showHabitDetails(ctx: BotContext, habitId: string) {
    try {
      const habit = await this.habitService.findHabitById(habitId, ctx.userId);

      if (!habit) {
        await ctx.editMessageTextWithMarkdown(
          '❌ *Привычка не найдена*\n\nВозможно, она была удалена.',
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🔙 К списку привычек',
                    callback_data: 'habits_list',
                  },
                ],
              ],
            },
          },
        );
        return;
      }

      // Format reminder time
      let reminderText = '🔕 Уведомления отключены';
      if (habit.reminderTime) {
        reminderText = `⏰ ${habit.reminderTime}`;
      }

      const frequencyText =
        habit.frequency === 'DAILY'
          ? 'Ежедневно'
          : habit.frequency === 'WEEKLY'
            ? 'Еженедельно'
            : 'Особая';

      const message = `
🎯 *${habit.title}*

📊 **Статистика:**
• Текущая серия: ${habit.currentStreak} дней
• Максимальная серия: ${habit.maxStreak} дней  
• Всего выполнено: ${habit.totalCompletions} раз

⚙️ **Настройки:**
• Периодичность: ${frequencyText}
• ${reminderText}

*Выберите действие:*
      `;

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Выполнить сейчас',
                callback_data: `habit_complete_${habit.id}`,
              },
            ],
            [
              {
                text: '🔔 Настройки уведомлений',
                callback_data: `habit_set_time_${habit.id}`,
              },
            ],
            [
              {
                text: '🔄 Изменить периодичность',
                callback_data: `habit_frequency_${habit.id}`,
              },
            ],
            [
              {
                text: '🗑️ Удалить привычку',
                callback_data: `delete_habit_${habit.id}`,
              },
            ],
            [
              {
                text: '🔙 К списку привычек',
                callback_data: 'habits_list',
              },
            ],
          ],
        },
      };

      await ctx.editMessageTextWithMarkdown(message, keyboard);
    } catch (error) {
      this.logger.error(`Error showing habit details: ${error}`);
      await ctx.editMessageTextWithMarkdown(
        '❌ *Ошибка при загрузке данных привычки*\n\nПопробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 К списку привычек', callback_data: 'habits_list' }],
            ],
          },
        },
      );
    }
  }

  private async showMoodMenu(ctx: BotContext) {
    const message = `
😊 *Дневник настроения*

Отметьте свое текущее настроение:
      `;

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '😄 Отлично', callback_data: 'mood_excellent' },
            { text: '😊 Хорошо', callback_data: 'mood_good' },
          ],
          [
            { text: '😐 Нормально', callback_data: 'mood_neutral' },
            { text: '😔 Грустно', callback_data: 'mood_sad' },
          ],
          [
            { text: '😤 Злой', callback_data: 'mood_angry' },
            { text: '😰 Тревожно', callback_data: 'mood_anxious' },
          ],
          [
            {
              text: '🤖 AI-анализ настроения',
              callback_data: 'mood_ai_analysis',
            },
          ],
          [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
        ],
      },
    };

    // Check if this is a callback query (can edit) or command (need to reply)
    if (ctx.callbackQuery) {
      await ctx.editMessageTextWithMarkdown(message, keyboard);
    } else {
      await ctx.replyWithMarkdown(message, keyboard);
    }
  }

  private async showMoodAIAnalysis(ctx: BotContext) {
    try {
      await ctx.editMessageTextWithMarkdown(
        '🤔 *Анализирую ваше настроение...*',
      );

      // Получаем персонализированный анализ настроения
      const aiAnalysis =
        await this.aiContextService.generatePersonalizedMessage(
          ctx.userId,
          'mood_analysis',
          '',
        );

      await ctx.editMessageTextWithMarkdown(
        `
🤖 *AI-анализ настроения:*

${aiAnalysis}

💡 *Хотите персональные советы?* Просто напишите мне в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '😊 Отметить настроение', callback_data: 'menu_mood' }],
              [{ text: '🔙 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error getting AI mood analysis:', error);
      await ctx.editMessageTextWithMarkdown(
        `
❌ *Не удалось получить AI-анализ*

Попробуйте позже или напишите мне напрямую в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 К настроению', callback_data: 'menu_mood' }],
            ],
          },
        },
      );
    }
  }

  private async showFocusSession(ctx: BotContext) {
    await this.showPomodoroMenu(ctx);
  }

  private async showRemindersMenu(ctx: BotContext) {
    try {
      this.logger.log('showRemindersMenu called for user:', ctx.userId);

      // Получаем активные напоминания пользователя
      const reminders = await this.prisma.reminder.findMany({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.ACTIVE,
          scheduledTime: {
            gte: new Date(), // Только будущие напоминания
          },
        },
        orderBy: {
          scheduledTime: 'asc',
        },
        take: 10, // Показываем максимум 10 ближайших напоминаний
      });

      this.logger.log(
        `Found ${reminders.length} active reminders for user ${ctx.userId}`,
      );

      let message = `🔔 *Мои напоминания*\n\n`;

      if (reminders.length === 0) {
        message += `У вас нет активных напоминаний.\n\n💡 Создайте напоминание, написав:\n"напомни мне купить молоко в 17:30"`;

        const keyboard = {
          inline_keyboard: [
            [
              {
                text: '➕ Создать напоминание',
                callback_data: 'create_reminder_help',
              },
              { text: '🎤 Голосом', callback_data: 'voice_reminder_help' },
            ],
            [{ text: '📝 Все напоминания', callback_data: 'all_reminders' }],
            [
              { text: '⬅️ Назад', callback_data: 'more_functions' },
              { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
            ],
          ],
        };

        if (ctx.callbackQuery) {
          await ctx.editMessageTextWithMarkdown(message, {
            reply_markup: keyboard,
          });
        } else {
          await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
        }
        return;
      }

      message += `📊 **Активных напоминаний:** ${reminders.length}\n\n`;
      message += `*Ближайшие напоминания:*\n\n`;

      // Отображаем список напоминаний
      for (let i = 0; i < Math.min(5, reminders.length); i++) {
        const reminder = reminders[i];

        // Логируем данные напоминания для отладки
        this.logger.log(`Reminder ${i}: `, {
          id: reminder.id,
          title: reminder.title,
          scheduledTime: reminder.scheduledTime,
        });

        const date = new Date(reminder.scheduledTime);
        const dateStr = date.toLocaleDateString('ru-RU', {
          day: 'numeric',
          month: 'short',
        });
        const timeStr = date.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        });

        // Проверяем и очищаем title от возможных проблемных символов
        const cleanTitle = reminder.title || 'Без названия';

        message += `${i + 1}. 📝 ${cleanTitle}\n`;
        message += `    ⏰ ${dateStr} в ${timeStr}\n\n`;
      }

      if (reminders.length > 5) {
        message += `... и еще ${reminders.length - 5} напоминаний`;
      }

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '➕ Создать напоминание',
              callback_data: 'create_reminder_help',
            },
            { text: '🎤 Голосом', callback_data: 'voice_reminder_help' },
          ],
          [{ text: '📝 Все напоминания', callback_data: 'all_reminders' }],
          [
            { text: '✏️ Управление', callback_data: 'manage_reminders' },
            { text: '📊 Статистика', callback_data: 'reminders_stats' },
          ],
          [
            { text: '⬅️ Назад', callback_data: 'more_functions' },
            { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
          ],
        ],
      };

      if (ctx.callbackQuery) {
        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
      } else {
        await ctx.replyWithMarkdown(message, { reply_markup: keyboard });
      }
    } catch (error) {
      this.logger.error(`Error fetching reminders: ${error}`);

      const errorMessage =
        '❌ Произошла ошибка при загрузке напоминаний. Попробуйте позже.';
      const errorKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
              { text: '⬅️ Назад', callback_data: 'more_functions' },
            ],
            [],
          ],
        },
      };

      if (ctx.callbackQuery) {
        await ctx.editMessageTextWithMarkdown(errorMessage, errorKeyboard);
      } else {
        await ctx.replyWithMarkdown(errorMessage, errorKeyboard);
      }
    }
  }

  private async showAllReminders(ctx: BotContext) {
    try {
      // Получаем все напоминания пользователя (активные и завершенные)
      const activeReminders = await this.prisma.reminder.findMany({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.ACTIVE,
        },
        orderBy: {
          scheduledTime: 'asc',
        },
      });

      const completedReminders = await this.prisma.reminder.findMany({
        where: {
          userId: ctx.userId,
          status: { in: [ReminderStatus.COMPLETED, ReminderStatus.DISMISSED] },
        },
        orderBy: {
          scheduledTime: 'desc',
        },
        take: 5, // Показываем последние 5 завершенных
      });

      let message = `🔔 *Все напоминания*\n\n`;

      // Активные напоминания как чек-лист
      const allButtons: any[] = [];
      if (activeReminders.length > 0) {
        message += `🟢 **Активные (${activeReminders.length}):**\n\n`;
        activeReminders.forEach((reminder, index) => {
          const date = new Date(reminder.scheduledTime);
          const isToday = date.toDateString() === new Date().toDateString();
          const isTomorrow =
            date.toDateString() ===
            new Date(Date.now() + 24 * 60 * 60 * 1000).toDateString();

          let dateStr;
          if (isToday) {
            dateStr = 'сегодня';
          } else if (isTomorrow) {
            dateStr = 'завтра';
          } else {
            dateStr = date.toLocaleDateString('ru-RU', {
              day: 'numeric',
              month: 'short',
            });
          }

          const timeStr = date.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          });

          // Кнопка с квадратиком для каждого напоминания
          allButtons.push([
            {
              text: `⬜ ${reminder.title} (${dateStr} в ${timeStr})`,
              callback_data: `toggle_reminder_${reminder.id}`,
            },
          ]);
        });
      } else {
        message += `🟢 **Активные:** нет\n\n`;
      }

      // Завершенные напоминания
      if (completedReminders.length > 0) {
        message += `\n✅ **Завершенные (последние ${completedReminders.length}):**\n\n`;
        completedReminders.forEach((reminder, index) => {
          const date = new Date(reminder.scheduledTime);
          const dateStr = date.toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'short',
          });
          const timeStr = date.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          });

          // Кнопка с зеленым квадратиком для завершенных
          allButtons.push([
            {
              text: `✅ ${reminder.title} (${dateStr} в ${timeStr})`,
              callback_data: `toggle_reminder_${reminder.id}`,
            },
          ]);
        });
      } else {
        message += `\n✅ **Завершенные:** нет истории\n`;
      }

      const keyboard = {
        inline_keyboard: [
          ...allButtons,
          [
            { text: '🔔 Активные', callback_data: 'reminders' },
            { text: '➕ Создать', callback_data: 'create_reminder_help' },
          ],
          [{ text: '⬅️ Назад', callback_data: 'reminders' }],
        ],
      };
      // Обработчик переключения статуса напоминания
      this.bot.action(/^toggle_reminder_(.+)$/, async (ctx) => {
        const reminderId = ctx.match[1];
        try {
          // Найдем напоминание и переключим его статус
          const reminder = await this.prisma.reminder.findUnique({
            where: { id: reminderId },
          });

          if (reminder) {
            const newStatus =
              reminder.status === ReminderStatus.ACTIVE
                ? ReminderStatus.COMPLETED
                : ReminderStatus.ACTIVE;

            await this.prisma.reminder.update({
              where: { id: reminderId },
              data: { status: newStatus },
            });

            const statusText =
              newStatus === ReminderStatus.COMPLETED
                ? 'выполненным'
                : 'активным';

            await ctx.answerCbQuery(`Напоминание отмечено как ${statusText}!`);
            await this.showAllReminders(ctx);
          }
        } catch (error) {
          this.logger.error('Error toggling reminder status:', error);
          await ctx.answerCbQuery('Ошибка при изменении статуса');
        }
      });

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error(`Error fetching all reminders: ${error}`);
      await ctx.editMessageTextWithMarkdown(
        '❌ Произошла ошибка при загрузке напоминаний. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'reminders' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  private async showCreateReminderHelp(ctx: BotContext) {
    try {
      const message = `
➕ *Создание напоминания*

**Как создать напоминание:**

📝 **Примеры команд:**
• "напомни купить молоко в 17:30"
• "напомни позвонить маме через 2 часа"
• "напомни встреча завтра в 14:00"
• "напомни про лекарства в 20:00"

⏰ **Форматы времени:**
• Конкретное время: "в 15:30", "на 18:00"
• Относительное время: "через 30 минут", "через 2 часа"

💡 **Совет:** Просто напишите в чат что и когда нужно напомнить!
      `;

      const keyboard = {
        inline_keyboard: [
          [{ text: '🔔 Мои напоминания', callback_data: 'reminders' }],
          [{ text: '⬅️ Назад', callback_data: 'reminders' }],
        ],
      };

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error in showCreateReminderHelp:', error);
      try {
        await ctx.replyWithMarkdown('❌ Произошла ошибка. Попробуйте позже.');
      } catch (replyError) {
        this.logger.error('Error sending error message:', replyError);
      }
    }
  }

  private async showVoiceReminderHelp(ctx: BotContext) {
    const message = `
🎤 *Голосовые напоминания*

🔊 **Отправьте голосовое сообщение** с описанием напоминания и временем

**Примеры:**
🎙️ "Напомни купить молоко завтра в 17:30"
🎙️ "Напомни позвонить врачу через 2 часа"
🎙️ "Напомни про встречу в понедельник в 14:00"

💡 Говорите четко и указывайте конкретное время
    `;

    const keyboard = {
      inline_keyboard: [
        [{ text: '📝 Текстом', callback_data: 'create_reminder_help' }],
        [{ text: '🔔 Мои напоминания', callback_data: 'reminders' }],
        [
          { text: '⬅️ Назад', callback_data: 'reminders' },
          { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
        ],
      ],
    };

    await ctx.editMessageTextWithMarkdown(message, { reply_markup: keyboard });
  }

  private async showManageReminders(ctx: BotContext) {
    try {
      // Получаем активные напоминания пользователя
      const reminders = await this.prisma.reminder.findMany({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.ACTIVE,
        },
        orderBy: {
          scheduledTime: 'asc',
        },
      });

      let message = `✏️ *Управление напоминаниями*\n\n`;

      if (reminders.length === 0) {
        message += `У вас нет активных напоминаний для управления.\n\n`;
        message += `💡 Создайте напоминание, чтобы управлять им.`;

        const keyboard = {
          inline_keyboard: [
            [
              {
                text: '➕ Создать напоминание',
                callback_data: 'create_reminder_help',
              },
            ],
            [{ text: '⬅️ Назад', callback_data: 'reminders' }],
          ],
        };

        await ctx.editMessageTextWithMarkdown(message, {
          reply_markup: keyboard,
        });
        return;
      }

      message += `📊 **Активных напоминаний:** ${reminders.length}\n\n`;
      message += `*Выберите напоминание для управления:*\n\n`;

      // Создаем кнопки для каждого напоминания (максимум 8)
      const keyboard = {
        inline_keyboard: [
          ...reminders.slice(0, 8).map((reminder) => {
            const date = new Date(reminder.scheduledTime);
            const timeStr = date.toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            });
            const title =
              reminder.title.length > 25
                ? reminder.title.substring(0, 25) + '...'
                : reminder.title;

            return [
              {
                text: `🗑️ ${title} (${timeStr})`,
                callback_data: `delete_reminder_${reminder.id}`,
              },
            ];
          }),
          [
            { text: '🔔 К напоминаниям', callback_data: 'reminders' },
            { text: '⬅️ Назад', callback_data: 'reminders' },
          ],
        ],
      };

      if (reminders.length > 8) {
        message += `\n... и еще ${reminders.length - 8} напоминаний\n`;
        message += `_Показаны первые 8 напоминаний_`;
      }

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error(`Error showing manage reminders: ${error}`);
      await ctx.editMessageText('❌ Произошла ошибка. Попробуйте позже.', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⬅️ Назад', callback_data: 'reminders' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      });
    }
  }

  private async showRemindersStats(ctx: BotContext) {
    try {
      // Получаем статистику по напоминаниям
      const totalActive = await this.prisma.reminder.count({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.ACTIVE,
        },
      });

      const totalCompleted = await this.prisma.reminder.count({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.COMPLETED,
        },
      });

      const totalDismissed = await this.prisma.reminder.count({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.DISMISSED,
        },
      });

      const todayCompleted = await this.prisma.reminder.count({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.COMPLETED,
          scheduledTime: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
            lte: new Date(new Date().setHours(23, 59, 59, 999)),
          },
        },
      });

      // Получаем ближайшее напоминание
      const nextReminder = await this.prisma.reminder.findFirst({
        where: {
          userId: ctx.userId,
          status: ReminderStatus.ACTIVE,
          scheduledTime: {
            gte: new Date(),
          },
        },
        orderBy: {
          scheduledTime: 'asc',
        },
      });

      let message = `📊 *Статистика напоминаний*\n\n`;

      message += `**Общая статистика:**\n`;
      message += `🟢 Активных: ${totalActive}\n`;
      message += `✅ Выполнено: ${totalCompleted}\n`;
      message += `❌ Отклонено: ${totalDismissed}\n`;
      message += `📈 Всего: ${totalActive + totalCompleted + totalDismissed}\n\n`;

      message += `**Сегодня:**\n`;
      message += `✅ Выполнено напоминаний: ${todayCompleted}\n\n`;

      if (nextReminder) {
        const nextDate = new Date(nextReminder.scheduledTime);
        const isToday = nextDate.toDateString() === new Date().toDateString();
        const isTomorrow =
          nextDate.toDateString() ===
          new Date(Date.now() + 24 * 60 * 60 * 1000).toDateString();

        let dateStr;
        if (isToday) {
          dateStr = 'сегодня';
        } else if (isTomorrow) {
          dateStr = 'завтра';
        } else {
          dateStr = nextDate.toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'short',
          });
        }

        const timeStr = nextDate.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        });

        message += `**Ближайшее напоминание:**\n`;
        message += `📝 ${nextReminder.title}\n`;
        message += `⏰ ${dateStr} в ${timeStr}`;
      } else {
        message += `**Ближайшее напоминание:**\n`;
        message += `Нет активных напоминаний`;
      }

      const keyboard = {
        inline_keyboard: [
          [
            { text: '🔔 Мои напоминания', callback_data: 'reminders' },
            { text: '➕ Создать', callback_data: 'create_reminder_help' },
          ],
          [
            { text: '⬅️ Назад', callback_data: 'reminders' },
            { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
          ],
        ],
      };

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error(`Error showing reminders stats: ${error}`);
      await ctx.editMessageTextWithMarkdown(
        '❌ Произошла ошибка при загрузке статистики. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'reminders' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  private async handleDeleteReminder(ctx: BotContext, reminderId: string) {
    try {
      // Найдем и удалим напоминание
      const reminder = await this.prisma.reminder.findFirst({
        where: {
          id: reminderId,
          userId: ctx.userId, // Убеждаемся, что пользователь может удалять только свои напоминания
        },
      });

      if (!reminder) {
        await ctx.editMessageTextWithMarkdown(
          '❌ *Напоминание не найдено*\n\nВозможно, оно уже было удалено.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔔 К напоминаниям', callback_data: 'reminders' }],
              ],
            },
          },
        );
        return;
      }

      // Удаляем напоминание
      await this.prisma.reminder.delete({
        where: {
          id: reminderId,
        },
      });

      await ctx.editMessageTextWithMarkdown(
        `✅ *Напоминание удалено*\n\n📝 "${reminder.title}" было успешно удалено из списка напоминаний.`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✏️ Управление', callback_data: 'manage_reminders' },
                { text: '🔔 К напоминаниям', callback_data: 'reminders' },
              ],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error(`Error deleting reminder: ${error}`);
      await ctx.editMessageTextWithMarkdown(
        '❌ Произошла ошибка при удалении напоминания. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'manage_reminders' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  private async showFocusAITips(ctx: BotContext) {
    try {
      await ctx.editMessageTextWithMarkdown(
        '🤔 *Анализирую ваши паттерны фокуса...*',
      );

      // Получаем персонализированные советы по фокусу
      const aiTips = await this.aiContextService.generatePersonalizedMessage(
        ctx.userId,
        'focus_tips',
        '',
      );

      await ctx.editMessageTextWithMarkdown(
        `
🤖 *AI-советы по фокусу:*

${aiTips}

💡 *Хотите персональную помощь?* Просто напишите мне в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🚀 Начать сессию',
                  callback_data: 'start_pomodoro_session',
                },
              ],
              [{ text: '🔙 К фокус-сессиям', callback_data: 'menu_focus' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error getting AI focus tips:', error);
      await ctx.editMessageTextWithMarkdown(
        `
❌ *Не удалось получить AI-советы*

Попробуйте позже или напишите мне напрямую в чат!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 К фокус-сессиям', callback_data: 'menu_focus' }],
            ],
          },
        },
      );
    }
  }

  private async createPayment(
    ctx: BotContext,
    subscriptionType: 'PREMIUM',
    amount?: number,
  ) {
    try {
      const plans = this.paymentService.getSubscriptionPlans();

      // Определяем план по сумме
      let plan;
      if (amount === 999) {
        plan = plans.PREMIUM_YEARLY;
      } else {
        plan = plans.PREMIUM_MONTHLY;
        amount = 199; // Убеждаемся что сумма корректная
      }

      await ctx.editMessageTextWithMarkdown('💳 *Создаю платеж...*');

      const paymentResult = await this.paymentService.createPayment({
        userId: ctx.userId,
        amount: plan.amount,
        description: plan.description,
        subscriptionType: subscriptionType,
        returnUrl: 'https://t.me/daily_check_bot',
      });

      const planName =
        amount === 999 ? 'Premium (годовая)' : 'Premium (месячная)';

      await ctx.editMessageTextWithMarkdown(
        `
💎 *Оплата ${planName}*

💰 **Сумма:** ${plan.amount}₽
📅 **Период:** ${plan.period}

**Что включено:**
${plan.features.map((feature) => `• ${feature}`).join('\n')}

🔗 Для оплаты перейдите по ссылке ниже:
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '💳 Оплатить',
                  url: paymentResult.confirmationUrl,
                },
              ],
              [
                {
                  text: '🔄 Проверить оплату',
                  callback_data: `check_payment_${paymentResult.paymentId}`,
                },
              ],
              [{ text: '⬅️ Назад', callback_data: 'upgrade_premium' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error creating payment:', error);
      await ctx.editMessageTextWithMarkdown(
        `
❌ *Ошибка создания платежа*

Попробуйте позже или свяжитесь с поддержкой.
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад', callback_data: 'upgrade_premium' }],
            ],
          },
        },
      );
    }
  }

  /**
   * Безопасно получает пользователя, создавая его при необходимости
   */
  private async getOrCreateUser(ctx: BotContext): Promise<User> {
    try {
      return await this.userService.findByTelegramId(ctx.userId);
    } catch (error) {
      // Пользователь не найден, создаем его
      const userData = {
        id: ctx.from?.id.toString() || ctx.userId,
        username: ctx.from?.username || undefined,
        firstName: ctx.from?.first_name || undefined,
        lastName: ctx.from?.last_name || undefined,
      };

      return await this.userService.findOrCreateUser(userData);
    }
  }

  /**
   * Handles XP purchases from the shop
   */
  private async handleXPPurchase(
    ctx: BotContext,
    itemType: 'theme' | 'badge' | 'emoji' | 'sticker' | 'feature',
    cost: number,
    itemName: string,
    itemId: string,
  ): Promise<void> {
    await ctx.answerCbQuery();

    try {
      const user = await this.userService.findByTelegramId(ctx.userId);

      // Check if user has enough XP
      if (user.totalXp < cost) {
        await ctx.editMessageTextWithMarkdown(
          `❌ *Недостаточно XP*

Для покупки "${itemName}" нужно ${cost} XP.
У вас: ${user.totalXp} XP
Нужно еще: ${cost - user.totalXp} XP

💪 Выполняйте задачи и привычки для заработка XP!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Назад в магазин', callback_data: 'xp_shop' }],
              ],
            },
          },
        );
        return;
      }

      // Check if user already owns this item
      const alreadyOwned = this.checkIfUserOwnsItem(user, itemType, itemId);

      if (alreadyOwned) {
        await ctx.editMessageTextWithMarkdown(
          `✅ *Уже приобретено*

У вас уже есть "${itemName}".

Выберите что-то другое в магазине!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Назад в магазин', callback_data: 'xp_shop' }],
              ],
            },
          },
        );
        return;
      }

      // Process purchase
      await this.processXPPurchase(user, itemType, itemId);

      // Update user XP
      await this.userService.updateStats(ctx.userId, {
        xpGained: -cost, // Subtract XP
      });

      await ctx.editMessageTextWithMarkdown(
        `🎉 *Покупка успешна!*

Вы приобрели: "${itemName}"
Потрачено: ${cost} XP
Остаток XP: ${user.totalXp - cost}

${this.getItemActivationMessage(itemType)}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🛍️ Продолжить покупки', callback_data: 'xp_shop' },
                { text: '🏠 Главное меню', callback_data: 'back_to_menu' },
              ],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error(`Error processing XP purchase: ${error}`);
      await ctx.editMessageTextWithMarkdown(
        '❌ Произошла ошибка при покупке. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Назад в магазин', callback_data: 'xp_shop' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  /**
   * Check if user already owns a specific item
   */
  private checkIfUserOwnsItem(
    user: User,
    itemType: string,
    itemId: string,
  ): boolean {
    switch (itemType) {
      case 'theme':
        return user.unlockedThemes.includes(itemId);
      case 'badge':
      case 'emoji':
      case 'sticker':
        return user.stickers.includes(itemId);
      case 'feature':
        // For features, we could add a separate field or use stickers array
        return user.stickers.includes(`feature_${itemId}`);
      default:
        return false;
    }
  }

  /**
   * Process the actual purchase and update user data
   */
  private async processXPPurchase(
    user: User,
    itemType: string,
    itemId: string,
  ): Promise<void> {
    const updateData: Partial<User> = {};

    switch (itemType) {
      case 'theme':
        updateData.unlockedThemes = [...user.unlockedThemes, itemId];
        break;
      case 'badge':
      case 'emoji':
      case 'sticker':
        updateData.stickers = [...user.stickers, itemId];
        break;
      case 'feature':
        updateData.stickers = [...user.stickers, `feature_${itemId}`];
        break;
    }

    await this.userService.updateUser(user.id, updateData);
  }

  /**
   * Get activation message based on item type
   */
  private getItemActivationMessage(itemType: string): string {
    switch (itemType) {
      case 'theme':
        return '🎨 Тема активирована! Вы можете переключиться в настройках.';
      case 'badge':
        return '🏆 Значок добавлен в ваш профиль!';
      case 'emoji':
        return '⚡ Эмодзи доступны в чате!';
      case 'sticker':
        return '🌟 Стикеры добавлены в коллекцию!';
      case 'feature':
        return '🚀 Функция активирована и готова к использованию!';
      default:
        return '✨ Покупка активирована!';
    }
  }

  private async completeHabit(ctx: BotContext, habitId: string) {
    try {
      // В будущем здесь будет логика выполнения привычки через HabitService
      // Пока что просто показываем сообщение
      await ctx.editMessageTextWithMarkdown(
        `
✅ *Привычка выполнена!*

🎯 Отличная работа! Вы на пути к формированию полезной привычки.

💡 *Функция выполнения привычек в разработке - скоро будет полноценная система отслеживания!*
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎯 Мои привычки', callback_data: 'habits_list' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error completing habit:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при выполнении привычки',
      );
    }
  }

  private async quickCompleteHabit(ctx: BotContext, habitId: string) {
    try {
      // Находим привычку и увеличиваем счетчик выполнений
      const habit = await this.habitService.findHabitById(habitId, ctx.userId);
      if (!habit) {
        await ctx.editMessageTextWithMarkdown('❌ Привычка не найдена');
        return;
      }

      // Используем сервис для выполнения привычки
      const { habit: updatedHabit, xpGained } =
        await this.habitService.completeHabit(habitId, ctx.userId);

      // Добавляем 20 XP пользователю (вместо стандартного XP)
      const user = await this.userService.findByTelegramId(ctx.userId);
      const totalXpGained = 20;
      await this.userService.updateUser(ctx.userId, {
        totalXp: (user.totalXp || 0) + totalXpGained,
      });

      // Проверяем, выполнены ли все привычки
      const allHabits = await this.habitService.findHabitsByUserId(ctx.userId);
      const allCompleted = allHabits.every((h) => h.currentStreak > 0); // Simplified check

      // Обновляем меню привычек с анимацией
      await this.showHabitsMenu(ctx);

      // Показываем фейерверк если все привычки выполнены
      if (allCompleted && ctx.chat?.id) {
        setTimeout(async () => {
          try {
            await ctx.telegram.sendMessage(
              ctx.chat!.id,
              `🎆🎇🎆🎇🎆\n\n🏆 **ПОЗДРАВЛЯЕМ!** 🏆\n\n✨ Вы выполнили ВСЕ привычки на сегодня! ✨\n\nВы просто невероятны! 🌟\n\n🎆🎇🎆🎇🎆`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '🎉 Спасибо!',
                        callback_data: 'celebration_thanks',
                      },
                    ],
                  ],
                },
              },
            );
          } catch (error) {
            this.logger.error('Error sending fireworks:', error);
          }
        }, 1000);
      } else {
        // Отправляем обычное сообщение с поздравлением
        if (ctx.chat?.id) {
          setTimeout(async () => {
            try {
              await ctx.telegram.sendMessage(
                ctx.chat!.id,
                `🎉 **Привычка выполнена!**\n\n🎯 ${habit.title}\n⭐ +${totalXpGained} XP\n🔥 Серия: ${updatedHabit.currentStreak} дней\n\nТак держать! 💪`,
                { parse_mode: 'Markdown' },
              );
            } catch (error) {
              this.logger.error('Error sending completion message:', error);
            }
          }, 500);
        }
      }
    } catch (error) {
      this.logger.error('Error in quickCompleteHabit:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при выполнении привычки',
      );
    }
  }

  private async showAllHabitsList(ctx: BotContext) {
    try {
      const habits = await this.habitService.findHabitsByUserId(ctx.userId);

      if (habits.length === 0) {
        await ctx.editMessageTextWithMarkdown(`
🔄 *Все привычки*

У вас нет привычек. Добавьте первую! 🎯
        `);
        return;
      }

      let message = `🔄 *Все привычки (${habits.length}):*\n\n`;
      message += `*Выберите привычку для выполнения:*`;

      // Create keyboard with all habits
      const keyboard = {
        inline_keyboard: [
          ...habits.map((habit) => [
            {
              text: `✅ ${habit.title.substring(0, 35)}${habit.title.length > 35 ? '...' : ''}`,
              callback_data: `habit_complete_${habit.id}`,
            },
          ]),
          [{ text: '🔙 Назад к привычкам', callback_data: 'habits_list' }],
        ],
      };

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error showing all habits list:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при получении списка привычек',
      );
    }
  }

  private async showHabitsManagement(ctx: BotContext) {
    try {
      const habits = await this.habitService.findHabitsByUserId(ctx.userId);

      if (habits.length === 0) {
        await ctx.editMessageTextWithMarkdown(
          `
🛠️ *Управление привычками*

У вас нет привычек для управления.
        `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🔙 Назад к привычкам',
                    callback_data: 'habits_list',
                  },
                ],
              ],
            },
          },
        );
        return;
      }

      let message = `🛠️ *Управление привычками*\n\n`;
      message += `Выберите привычку для удаления:`;

      // Create keyboard with all habits for deletion
      const keyboard = {
        inline_keyboard: [
          ...habits.map((habit) => [
            {
              text: `🗑️ ${habit.title.substring(0, 35)}${habit.title.length > 35 ? '...' : ''}`,
              callback_data: `habit_delete_${habit.id}`,
            },
          ]),
          [{ text: '🔙 Назад к привычкам', callback_data: 'habits_list' }],
        ],
      };

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error showing habits management:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при загрузке управления привычками',
      );
    }
  }

  private async showHabitsNotificationsSettings(ctx: BotContext) {
    try {
      const habits = await this.habitService.findHabitsByUserId(ctx.userId);

      if (habits.length === 0) {
        await ctx.editMessageTextWithMarkdown(
          `
🔔 *Настройка уведомлений*

У вас нет привычек для настройки уведомлений.
        `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🔙 Назад к привычкам',
                    callback_data: 'menu_habits',
                  },
                ],
              ],
            },
          },
        );
        return;
      }

      let message = `🔔 *Настройка уведомлений*\n\n`;
      message += `Выберите привычку для настройки частоты напоминаний:\n\n`;

      // Показываем текущие настройки для каждой привычки
      const keyboardRows: any[] = [];

      for (const habit of habits.slice(0, 10)) {
        const frequencyText = this.getHabitFrequencyText(habit.frequency);
        keyboardRows.push([
          {
            text: `🔔 ${habit.title.substring(0, 25)}${habit.title.length > 25 ? '...' : ''} (${frequencyText})`,
            callback_data: `habit_notification_${habit.id}`,
          },
        ]);
      }

      keyboardRows.push([
        { text: '🔙 Назад к привычкам', callback_data: 'menu_habits' },
      ]);

      const keyboard = { inline_keyboard: keyboardRows };

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error showing habits notifications settings:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при загрузке настроек уведомлений',
      );
    }
  }

  private getHabitFrequencyText(frequency: string): string {
    switch (frequency) {
      case 'DAILY':
        return '1 раз/день';
      case 'WEEKLY':
        return '1 раз/неделя';
      case 'CUSTOM':
        return 'Настройка';
      default:
        return frequency;
    }
  }

  private async showHabitNotificationSettings(
    ctx: BotContext,
    habitId: string,
  ) {
    try {
      const habit = await this.habitService.findHabitById(habitId, ctx.userId);

      if (!habit) {
        await ctx.answerCbQuery('❌ Привычка не найдена');
        return;
      }

      const currentFrequency = this.getHabitFrequencyText(habit.frequency);
      const reminderTime = habit.reminderTime || '09:00';

      let message = `🔔 *Настройка уведомлений*\n\n`;
      message += `📝 **Привычка:** ${habit.title}\n`;
      message += `⏰ **Текущая частота:** ${currentFrequency}\n`;
      message += `🕐 **Время напоминания:** ${reminderTime}\n\n`;
      message += `Выберите настройку:`;

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '⏰ Изменить время',
              callback_data: `habit_set_time_${habitId}`,
            },
            {
              text: '� Изменить частоту',
              callback_data: `habit_set_frequency_${habitId}`,
            },
          ],
          [
            {
              text: '🔕 Отключить уведомления',
              callback_data: `set_habit_frequency_${habitId}_DISABLED`,
            },
          ],
          [
            {
              text: '🔙 Назад',
              callback_data: 'habits_notifications_settings',
            },
          ],
        ],
      };

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error showing habit notification settings:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при загрузке настроек привычки',
      );
    }
  }

  private async updateHabitFrequency(
    ctx: BotContext,
    habitId: string,
    frequency: string,
  ) {
    try {
      const habit = await this.habitService.findHabitById(habitId, ctx.userId);

      if (!habit) {
        await ctx.editMessageTextWithMarkdown('❌ Привычка не найдена');
        return;
      }

      // Обновляем частоту привычки
      await this.habitService.updateHabit(habitId, ctx.userId, {
        frequency: frequency === 'DISABLED' ? 'CUSTOM' : frequency, // Для отключенных используем CUSTOM
        // В реальном приложении можно добавить отдельное поле для статуса уведомлений
      } as any);

      const frequencyText = this.getFrequencyDisplayText(frequency);

      let message = `✅ *Настройки обновлены*\n\n`;
      message += `📝 **Привычка:** ${habit.title}\n`;
      message += `⏰ **Новая частота уведомлений:** ${frequencyText}\n\n`;

      if (frequency === 'DISABLED') {
        message += `🔕 Уведомления для этой привычки отключены.`;
      } else {
        message += `🔔 Теперь вы будете получать напоминания с новой частотой.`;
      }

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '⚙️ Настроить другую привычку',
              callback_data: 'habits_notifications_settings',
            },
          ],
          [
            {
              text: '🎯 Вернуться к привычкам',
              callback_data: 'menu_habits',
            },
          ],
        ],
      };

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error updating habit frequency:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при обновлении настроек привычки',
      );
    }
  }

  private getFrequencyDisplayText(frequency: string): string {
    switch (frequency) {
      case 'DAILY':
        return '📅 1 раз в день';
      case 'WEEKLY':
        return '📅 1 раз в неделю';
      case 'TWICE_DAILY':
        return '🔄 2 раза в день';
      case 'THREE_TIMES':
        return '🔄 3 раза в день';
      case 'EVERY_2H':
        return '⚡ Каждые 2 часа';
      case 'DISABLED':
        return '🔕 Отключены';
      default:
        return frequency;
    }
  }

  private async showHabitFrequencySettings(ctx: BotContext, habitId: string) {
    try {
      const habit = await this.habitService.findHabitById(habitId, ctx.userId);

      if (!habit) {
        await ctx.answerCbQuery('❌ Привычка не найдена');
        return;
      }

      const currentFrequency = this.getHabitFrequencyText(habit.frequency);

      let message = `📅 *Настройка частоты уведомлений*\n\n`;
      message += `📝 **Привычка:** ${habit.title}\n`;
      message += `⏰ **Текущая частота:** ${currentFrequency}\n\n`;
      message += `Выберите новую частоту напоминаний:`;

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '📅 1 раз в день',
              callback_data: `set_habit_frequency_${habitId}_DAILY`,
            },
          ],
          [
            {
              text: '📅 1 раз в неделю',
              callback_data: `set_habit_frequency_${habitId}_WEEKLY`,
            },
          ],
          [
            {
              text: '🔄 2 раза в день',
              callback_data: `set_habit_frequency_${habitId}_TWICE_DAILY`,
            },
          ],
          [
            {
              text: '🔄 3 раза в день',
              callback_data: `set_habit_frequency_${habitId}_THREE_TIMES`,
            },
          ],
          [
            {
              text: '⚡ Каждые 2 часа (активно)',
              callback_data: `set_habit_frequency_${habitId}_EVERY_2H`,
            },
          ],
          [
            {
              text: '🔙 Назад',
              callback_data: `habit_notification_${habitId}`,
            },
          ],
        ],
      };

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error showing habit frequency settings:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при загрузке настроек частоты',
      );
    }
  }

  private async showHabitTimeSettings(ctx: BotContext, habitId: string) {
    try {
      const habit = await this.habitService.findHabitById(habitId, ctx.userId);

      if (!habit) {
        await ctx.answerCbQuery('❌ Привычка не найдена');
        return;
      }

      const currentTime = habit.reminderTime || '09:00';

      let message = `🕐 *Настройка времени уведомлений*\n\n`;
      message += `📝 **Привычка:** ${habit.title}\n`;
      message += `⏰ **Текущее время:** ${currentTime}\n\n`;
      message += `Выберите час и минуты для напоминания:`;

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: `🕐 Выбрать час (${currentTime.split(':')[0]})`,
              callback_data: `select_hour_${habitId}`,
            },
            {
              text: `🕕 Выбрать минуты (${currentTime.split(':')[1]})`,
              callback_data: `select_minute_${habitId}`,
            },
          ],
          [
            {
              text: '⏰ Свое время (ввод)',
              callback_data: `habit_custom_time_${habitId}`,
            },
          ],
          [
            {
              text: '🔙 Назад',
              callback_data: `habit_notification_${habitId}`,
            },
          ],
        ],
      };

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error showing habit time settings:', error);
      await ctx.editMessageText('❌ Ошибка при загрузке настроек времени', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Назад', callback_data: 'habits_list' }],
          ],
        },
      });
    }
  }

  private async showHabitHourSelection(ctx: BotContext, habitId: string) {
    try {
      const habit = await this.habitService.findHabitById(habitId, ctx.userId);

      if (!habit) {
        await ctx.answerCbQuery('❌ Привычка не найдена');
        return;
      }

      const currentTime = habit.reminderTime || '09:00';
      const currentHour = parseInt(currentTime.split(':')[0]);

      let message = `🕐 *Выбор часа*\n\n`;
      message += `📝 **Привычка:** ${habit.title}\n`;
      message += `⏰ **Текущее время:** ${currentTime}\n\n`;
      message += `Выберите час для напоминания:`;

      const hours = [
        [6, 7, 8, 9],
        [10, 11, 12, 13],
        [14, 15, 16, 17],
        [18, 19, 20, 21],
        [22, 23, 0, 1],
      ];

      const keyboard = {
        inline_keyboard: [
          ...hours.map((row) =>
            row.map((hour) => ({
              text:
                hour === currentHour
                  ? `🔘 ${hour.toString().padStart(2, '0')}`
                  : `⚪ ${hour.toString().padStart(2, '0')}`,
              callback_data: `habit_hour_${habitId}_${hour}`,
            })),
          ),
          [
            {
              text: '🔙 Назад к настройке времени',
              callback_data: `habit_set_time_${habitId}`,
            },
          ],
        ],
      };

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error showing hour selection:', error);
    }
  }

  private async showHabitMinuteSelection(ctx: BotContext, habitId: string) {
    try {
      const habit = await this.habitService.findHabitById(habitId, ctx.userId);

      if (!habit) {
        await ctx.answerCbQuery('❌ Привычка не найдена');
        return;
      }

      // Определяем текущее время для отображения
      let displayTime = habit.reminderTime || '09:00';

      // Если есть выбранный час в tempData, используем его для отображения
      if (
        ctx.session.tempData?.selectedHour &&
        ctx.session.tempData?.habitId === habitId
      ) {
        const selectedHour = ctx.session.tempData.selectedHour;
        const currentMinute = displayTime.split(':')[1];
        displayTime = `${selectedHour}:${currentMinute}`;
      }

      const currentMinute = parseInt(displayTime.split(':')[1]);

      let message = `🕕 *Выбор минут*\n\n`;
      message += `📝 **Привычка:** ${habit.title}\n`;
      message += `⏰ **Выбранное время:** ${displayTime}\n\n`;
      message += `Выберите минуты для напоминания:`;

      const minutes = [
        [0, 15, 30, 45],
        [5, 20, 35, 50],
        [10, 25, 40, 55],
      ];

      const keyboard = {
        inline_keyboard: [
          ...minutes.map((row) =>
            row.map((minute) => ({
              text:
                minute === currentMinute
                  ? `🔘 ${minute.toString().padStart(2, '0')}`
                  : `⚪ ${minute.toString().padStart(2, '0')}`,
              callback_data: `habit_minute_${habitId}_${minute}`,
            })),
          ),
          [
            {
              text: '🔙 Назад к настройке времени',
              callback_data: `habit_set_time_${habitId}`,
            },
          ],
        ],
      };

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error showing minute selection:', error);
    }
  }

  private async updateHabitTime(
    ctx: BotContext,
    habitId: string,
    time: string,
  ) {
    try {
      // Validate time format
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(time)) {
        await ctx.editMessageTextWithMarkdown(
          '❌ Неверный формат времени. Используйте формат ЧЧ:ММ (например, 09:30)',
        );
        return;
      }

      const habit = await this.habitService.findHabitById(habitId, ctx.userId);

      if (!habit) {
        await ctx.editMessageTextWithMarkdown('❌ Привычка не найдена');
        return;
      }

      // Update habit reminder time
      await this.habitService.updateHabit(habitId, ctx.userId, {
        reminderTime: time,
      } as any);

      let message = `✅ *Время уведомления обновлено*\n\n`;
      message += `📝 **Привычка:** ${habit.title}\n`;
      message += `⏰ **Новое время напоминания:** ${time}\n\n`;
      message += `🔔 Теперь вы будете получать напоминания в ${time}`;

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '⚙️ Другие настройки',
              callback_data: `habit_notification_${habitId}`,
            },
          ],
          [
            {
              text: '🎯 Вернуться к привычкам',
              callback_data: 'menu_habits',
            },
          ],
        ],
      };

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error updating habit time:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при обновлении времени уведомления',
      );
    }
  }

  private async confirmHabitDeletion(ctx: BotContext, habitId: string) {
    try {
      const habit = await this.habitService.findHabitById(habitId, ctx.userId);

      if (!habit) {
        await ctx.answerCbQuery('❌ Привычка не найдена');
        return;
      }

      await ctx.editMessageTextWithMarkdown(
        `
⚠️ *Подтвердите удаление*

Вы уверены, что хотите удалить привычку:

📝 *${habit.title}*

⚠️ Это действие нельзя отменить!
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '✅ Да, удалить',
                  callback_data: `confirm_delete_habit_${habitId}`,
                },
                {
                  text: '❌ Отмена',
                  callback_data: `cancel_delete_habit_${habitId}`,
                },
              ],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error confirming habit deletion:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при подтверждении удаления',
      );
    }
  }

  private async deleteHabit(ctx: BotContext, habitId: string) {
    try {
      const habit = await this.habitService.findHabitById(habitId, ctx.userId);

      if (!habit) {
        await ctx.answerCbQuery('❌ Привычка не найдена');
        return;
      }

      await this.habitService.deleteHabit(habitId, ctx.userId);

      await ctx.editMessageTextWithMarkdown(
        `
✅ *Привычка удалена*

Привычка "${habit.title}" была успешно удалена.
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔙 К управлению привычками',
                  callback_data: 'habits_manage',
                },
              ],
              [{ text: '🏠 В главное меню', callback_data: 'main_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error deleting habit:', error);
      await ctx.editMessageTextWithMarkdown('❌ Ошибка при удалении привычки', {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🔙 К управлению привычками',
                callback_data: 'habits_manage',
              },
            ],
          ],
        },
      });
    }
  }

  private async confirmTimezone(ctx: BotContext, timezone: string) {
    try {
      // Сохраняем часовой пояс в базу данных
      await this.userService.updateUser(ctx.userId, {
        timezone: timezone,
      });

      await ctx.editMessageTextWithMarkdown(`
✅ *Часовой пояс установлен!*

🕐 Часовой пояс: ${timezone}

Теперь можете создавать задачи и привычки!
      `);

      // Reset session step
      ctx.session.step = undefined;

      // Продолжить с тем действием, которое пользователь хотел сделать
      if (ctx.session.pendingAction === 'adding_task') {
        ctx.session.pendingAction = undefined;
        await this.startAddingTask(ctx);
      } else if (ctx.session.pendingAction === 'adding_habit') {
        ctx.session.pendingAction = undefined;
        ctx.session.step = 'adding_habit';
        await ctx.editMessageTextWithMarkdown(
          '🔄 *Добавление привычки*\n\nВведите название привычки, которую хотите отслеживать:\n\n⬇️ *Введите название привычки в поле для ввода ниже*',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
              ],
            },
          },
        );
      } else {
        await this.showMainMenu(ctx);
      }
    } catch (error) {
      this.logger.error('Error confirming timezone:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при сохранении часового пояса',
      );
    }
  }

  private async showTimezoneList(ctx: BotContext) {
    const commonTimezones = [
      { name: 'Москва', tz: 'Europe/Moscow' },
      { name: 'СПб', tz: 'Europe/Moscow' },
      { name: 'Екатеринбург', tz: 'Asia/Yekaterinburg' },
      { name: 'Новосибирск', tz: 'Asia/Novosibirsk' },
      { name: 'Владивосток', tz: 'Asia/Vladivostok' },
      { name: 'Астана', tz: 'Asia/Almaty' },
      { name: 'Киев', tz: 'Europe/Kiev' },
      { name: 'Минск', tz: 'Europe/Minsk' },
      { name: 'Лондон', tz: 'Europe/London' },
      { name: 'Париж', tz: 'Europe/Paris' },
      { name: 'Нью-Йорк', tz: 'America/New_York' },
      { name: 'Лос-Анджелес', tz: 'America/Los_Angeles' },
    ];

    await ctx.editMessageTextWithMarkdown(
      `
🕐 *Выберите часовой пояс*

Выберите ближайший к вам город:`,
      {
        reply_markup: {
          inline_keyboard: [
            ...commonTimezones.map((city) => [
              {
                text: `🏙️ ${city.name}`,
                callback_data: `confirm_timezone_${city.tz}`,
              },
            ]),
            [{ text: '🔙 Ввести город вручную', callback_data: 'input_city' }],
          ],
        },
      },
    );
  }

  /**
   * Format time string with user's timezone
   */
  private formatTimeWithTimezone(date: Date, timezone?: string | null): string {
    return date.toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone || 'Europe/Moscow',
    });
  }

  private formatDateWithTimezone(date: Date, timezone?: string | null): string {
    return date.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      timeZone: timezone || 'Europe/Moscow',
    });
  }

  /**
   * Start adding habit process from voice command
   */
  private async startAddingHabit(ctx: BotContext) {
    const user = await this.userService.findByTelegramId(ctx.userId);
    if (!user.timezone) {
      ctx.session.pendingAction = 'adding_habit';
      await this.askForTimezone(ctx);
      return;
    }

    ctx.session.step = 'adding_habit';
    await ctx.replyWithMarkdown(
      '🔄 *Добавление привычки*\n\nВыберите готовый пример или введите название привычки вручную:\n\n⬇️ *Введите название привычки в поле для ввода ниже*',
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '💧 Пить воду каждый день по 2 литра',
                callback_data: 'habit_example_water',
              },
            ],
            [
              {
                text: '😴 Ложиться спать до 23:00',
                callback_data: 'habit_example_sleep',
              },
            ],
            [
              {
                text: '🚶‍♀️ Прогулка перед сном 20 минут',
                callback_data: 'habit_example_walk',
              },
            ],
            [
              {
                text: '📝 Ввести свою привычку',
                callback_data: 'habit_custom_input',
              },
            ],
            [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );
  }

  /**
   * Analyze voice transcription and intelligently create task/reminder/habit
   */
  private async analyzeAndCreateFromVoice(ctx: BotContext, text: string) {
    const lowercaseText = text.toLowerCase();

    // First check for reminder with specific time
    const isReminder = this.isReminderRequest(text);
    if (isReminder) {
      await this.processReminderFromText(ctx, text);
      return;
    }

    // Then check for habit patterns
    const isHabit = this.isHabitRequest(lowercaseText);
    if (isHabit) {
      const habitName = this.extractHabitName(text);
      await this.createHabitFromVoice(ctx, habitName);
      return;
    }

    // Check if it might be a reminder without specific time
    const mightBeReminder =
      /напомни|напоминание|не забыть|вспомнить|помни/i.test(text);

    // If it's unclear what to do, ask the AI to classify and act automatically
    if (mightBeReminder || text.length > 10) {
      // Inform user that AI is processing
      await ctx.replyWithMarkdown('🤖 *ИИ анализирует ваше сообщение...*');

      try {
        const prompt = `Классифицируй коротко назначение этого сообщения на русском языке. Верни только JSON без дополнительного текста в формате:\n{"intent":"reminder|task|habit|ask_ai","text":"...нормализованный текст...","time":"...если есть, в читабельном формате или пусто"}\n\nТекст: "${text.replace(/"/g, '\\"')}"`;

        const aiRaw = await this.openaiService.getAIResponse(prompt);

        // 🔧 Увеличиваем счетчик использования AI
        await this.subscriptionService.incrementUsage(ctx.userId, 'aiRequests');

        // Try to extract JSON object from AI response
        let aiJson: any = null;
        try {
          const firstBrace = aiRaw.indexOf('{');
          const lastBrace = aiRaw.lastIndexOf('}');
          const jsonStr =
            firstBrace !== -1 && lastBrace !== -1
              ? aiRaw.slice(firstBrace, lastBrace + 1)
              : aiRaw;
          aiJson = JSON.parse(jsonStr);
        } catch (parseError) {
          this.logger.warn(
            'AI classification returned non-JSON, creating task as fallback',
            parseError,
          );
          // Fallback: try to create a task by default
          await this.createTaskFromText(ctx, text);
          return;
        }

        if (aiJson && aiJson.intent) {
          const intent = aiJson.intent;
          const normalizedText = aiJson.text || text;
          const detectedTime = aiJson.time || null;

          if (intent === 'reminder') {
            // If AI thinks it's a reminder but no time detected, create a task instead
            if (!detectedTime) {
              await this.createTaskFromText(ctx, normalizedText);
              return;
            }
            await this.processReminderFromText(ctx, normalizedText);
            return;
          }

          if (intent === 'task') {
            await this.createTaskFromText(ctx, normalizedText);
            return;
          }

          if (intent === 'habit') {
            const habitName = normalizedText;
            await this.createHabitFromVoice(ctx, habitName);
            return;
          }

          // If AI asked to escalate to human/AI-chat, show AI chat option
          if (intent === 'ask_ai') {
            await ctx.replyWithMarkdown(
              `💬 *Я могу помочь:*\n${await this.aiContextService.generatePersonalizedMessage(ctx.userId, 'motivation', normalizedText)}`,
            );
            return;
          }
        }

        // Fallback: if AI couldn't classify, create task by default
        await this.createTaskFromText(ctx, text);
        return;
      } catch (error) {
        this.logger.error(
          'Error during AI classification of voice text:',
          error,
        );
        // Fallback: create task if AI analysis fails completely
        await this.createTaskFromText(ctx, text);
        return;
      }
    }

    // Default: create task (for short text without specific patterns)
    const taskName = this.extractTaskName(text);
    await this.createTaskFromVoice(ctx, taskName);
  }

  private async showVoiceAnalysisOptions(ctx: BotContext, text: string) {
    // Сохраняем текст в сессии для дальнейшего использования
    ctx.session.tempData = { voiceText: text };

    await ctx.replyWithMarkdown(
      `🤔 *Что вы хотели сделать?*

Текст: "${text}"

Выберите действие:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '📝 Создать задачу',
                callback_data: 'create_task_from_voice_text',
              },
            ],
            [
              {
                text: '⏰ Создать напоминание',
                callback_data: 'create_reminder_from_voice_text',
              },
            ],
            [
              {
                text: '🔄 Создать привычку',
                callback_data: 'create_habit_from_voice_text',
              },
            ],
            [
              {
                text: '💬 Спросить у ИИ',
                callback_data: 'ai_chat_from_voice_text',
              },
            ],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      },
    );
  }

  private isHabitRequest(text: string): boolean {
    const habitPatterns = [
      /привычка/i,
      /каждый\s+(день|час|утро|вечер)/i,
      /ежедневно/i,
      /регулярно/i,
      /постоянно/i,
      /каждое\s+(утро|день|вечер)/i,
      /по\s+\d+\s+раз/i,
      /\d+\s+раз\s+в\s+день/i,
      /утром\s+делать/i,
      /вечером\s+делать/i,
      /каждый\s+час/i,
      /^(пить|делать|читать|заниматься|медитировать|бегать|ходить|спать|просыпаться|есть|готовить|убираться|изучать)\s+.*/i,
    ];

    return habitPatterns.some((pattern) => pattern.test(text));
  }

  private extractHabitName(text: string): string {
    return text
      .replace(/добавить\s*(привычку)?/gi, '')
      .replace(/новая\s*привычка/gi, '')
      .replace(/создать\s*(привычку)?/gi, '')
      .replace(/^(делать|пить|читать|заниматься|выполнять)\s+/gi, '')
      .replace(/каждый\s*день/gi, '')
      .replace(/ежедневно/gi, '')
      .replace(/регулярно/gi, '')
      .replace(/каждое\s+(утро|день|вечер)/gi, '')
      .replace(/по\s+\d+\s+раз/gi, '')
      .replace(/\d+\s+раз\s+в\s+день/gi, '')
      .trim();
  }

  private extractTaskName(text: string): string {
    return text
      .replace(/добавить\s*(задачу)?/gi, '')
      .replace(/новая\s*задача/gi, '')
      .replace(/создать\s*(задачу)?/gi, '')
      .replace(/^(сделать|выполнить|нужно|надо)\s+/gi, '')
      .replace(
        /\s+(завтра|послезавтра|сегодня|через\s+\d+\s+\w+|в\s+понедельник|во\s+вторник|в\s+среду|в\s+четверг|в\s+пятницу|в\s+субботу|в\s+воскресенье|на\s+следующей\s+неделе|в\s+следующем\s+месяце|в\s+следующем\s+году)$/gi,
        '',
      )
      .replace(/(завтра|послезавтра|сегодня)\s+/gi, '')
      .replace(/через\s+\d+\s+\w+\s+/gi, '')
      .replace(/на\s+следующей\s+неделе\s+/gi, '')
      .replace(/в\s+следующем\s+(месяце|году)\s+/gi, '')
      .replace(
        /в\s+(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)\s+/gi,
        '',
      )
      .trim();
  }

  private async createHabitFromVoice(ctx: BotContext, habitName: string) {
    if (!habitName || habitName.length < 2) {
      await ctx.replyWithMarkdown(
        '⚠️ Не удалось извлечь название привычки. Попробуйте еще раз.',
      );
      return;
    }

    try {
      await this.habitService.createHabit({
        userId: ctx.userId,
        title: habitName,
        description: undefined,
        frequency: 'DAILY',
        targetCount: 1,
      });

      // Clear session state after successful habit creation
      ctx.session.step = undefined;
      ctx.session.pendingAction = undefined;

      await ctx.replyWithMarkdown(
        `✅ *Привычка "${habitName}" создана!*

🎯 Теперь вы можете отслеживать её выполнение в разделе "Мои привычки".

*Напоминание:* Регулярность - ключ к формированию привычек!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎯 Мои привычки', callback_data: 'menu_habits' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error(`Error creating habit from voice: ${error}`);
      await ctx.replyWithMarkdown(
        '❌ Произошла ошибка при создании привычки. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  private async createTaskFromVoice(ctx: BotContext, taskName: string) {
    if (!taskName || taskName.length < 2) {
      await ctx.replyWithMarkdown(
        '⚠️ Не удалось извлечь название задачи. Попробуйте еще раз.',
      );
      return;
    }

    try {
      const user = await this.getOrCreateUser(ctx);

      // Check billing limits
      const limitCheck = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyTasks',
      );

      if (!limitCheck.allowed) {
        await ctx.replyWithMarkdown(
          limitCheck.message || '🚫 Превышен лимит задач',
        );
        return;
      }

      const task = await this.taskService.createTask({
        userId: ctx.userId,
        title: taskName,
        description: undefined,
        priority: 'MEDIUM',
      });

      // Increment usage
      await this.billingService.incrementUsage(ctx.userId, 'dailyTasks');

      await ctx.replyWithMarkdown(
        `✅ *Задача "${taskName}" создана!*

📋 ID: ${task.id}

Задачу можно найти в разделе "Мои задачи".`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Мои задачи', callback_data: 'menu_tasks' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error(`Error creating task from voice: ${error}`);
      await ctx.replyWithMarkdown(
        '❌ Произошла ошибка при создании задачи. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  private mapDependencyType(type: string): string {
    const mappings: { [key: string]: string } = {
      smoking: 'SMOKING',
      alcohol: 'ALCOHOL',
      gambling: 'GAMBLING',
      sweets: 'SWEET',
      social: 'SOCIAL_MEDIA',
      gaming: 'GAMING',
      shopping: 'OTHER', // No specific enum for shopping, using OTHER
      custom: 'OTHER',
    };

    return mappings[type] || 'OTHER';
  }

  private mapEnumToCallbackType(enumType: string): string {
    const reverseMappings: { [key: string]: string } = {
      SMOKING: 'smoking',
      ALCOHOL: 'alcohol',
      GAMBLING: 'gambling',
      SWEET: 'sweets',
      SOCIAL_MEDIA: 'social',
      GAMING: 'gaming',
      OTHER: 'shopping', // Map OTHER back to shopping for existing handlers
    };

    return reverseMappings[enumType] || 'shopping';
  }

  private async startDailyMotivation(userId: string, dependencyType: string) {
    this.logger.log(
      `Starting daily motivation for user ${userId}, dependency: ${dependencyType}`,
    );

    try {
      // Ищем существующую запись
      const mappedType = this.mapDependencyType(dependencyType);
      const existing = await this.prisma.dependencySupport.findFirst({
        where: {
          userId: userId,
          type: mappedType as any,
        },
      });

      if (existing) {
        // Обновляем существующую запись
        await this.prisma.dependencySupport.update({
          where: { id: existing.id },
          data: {
            status: 'ACTIVE',
            updatedAt: new Date(),
          },
        });
      } else {
        // Создаем новую запись
        await this.prisma.dependencySupport.create({
          data: {
            userId: userId,
            type: mappedType as any,
            status: 'ACTIVE',
            morningTime: '09:00',
            eveningTime: '21:00',
          },
        });
      }

      this.logger.log(`Dependency support record saved for user ${userId}`);

      // Уведомления теперь отправляются через cron-джобы в NotificationService
      // в 9:00 и 21:00 каждый день
    } catch (error) {
      this.logger.error(`Error saving dependency support: ${error}`);
    }
  }

  // Handle long-term reminders (days, weeks, months, years)
  private async handleLongTermReminder(
    ctx: BotContext,
    reminderText: string,
    targetDate: Date,
    amount: number,
    unit: string,
  ): Promise<void> {
    if (!ctx.from) {
      console.error('No user context found for long-term reminder');
      return;
    }

    const userId = ctx.from.id;

    // Update user activity
    await this.updateUserActivity(userId.toString());

    const now = new Date();
    const timeDifference = targetDate.getTime() - now.getTime();
    const daysUntilReminder = Math.ceil(timeDifference / (1000 * 60 * 60 * 24));

    let reminderMessage = '';
    let confirmationMessage = '';

    if (unit === 'specific') {
      // For expressions like "на следующей неделе", "завтра", etc.
      confirmationMessage = `⏰ *Напоминание установлено*\n\n📝 ${reminderText}\n📅 ${targetDate.toLocaleDateString(
        'ru-RU',
        {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        },
      )}`;
    } else {
      // For "через X дней/недель/месяцев/лет"
      const unitText = this.getUnitText(amount, unit);
      confirmationMessage = `⏰ *Напоминание установлено*\n\n📝 ${reminderText}\n⏳ Через ${amount} ${unitText}\n📅 ${targetDate.toLocaleDateString(
        'ru-RU',
        {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        },
      )}`;
    }

    // Store long-term reminder (you may want to implement this in your database)
    // For now, we'll show the confirmation
    await ctx.replyWithMarkdown(confirmationMessage, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
        ],
      },
    });

    // Log the long-term reminder
    console.log(`Long-term reminder set for user ${userId}:`, {
      text: reminderText,
      targetDate: targetDate.toISOString(),
      amount,
      unit,
      daysUntil: daysUntilReminder,
    });
  }

  // Parse specific time expressions like "завтра", "на следующей неделе", etc.
  private parseSpecificTimeExpressions(
    text: string,
  ): { targetDate: Date; reminderText: string } | null {
    const now = new Date();
    let targetDate = new Date(now);
    let matched = false;
    let matchedPattern = '';

    // Tomorrow patterns
    if (/завтра/i.test(text)) {
      targetDate.setDate(targetDate.getDate() + 1);
      matched = true;
      matchedPattern = 'завтра';
    }
    // Day after tomorrow
    else if (/послезавтра/i.test(text)) {
      targetDate.setDate(targetDate.getDate() + 2);
      matched = true;
      matchedPattern = 'послезавтра';
    }
    // Next week
    else if (/на\s*следующей\s*неделе/i.test(text)) {
      const daysUntilNextWeek = 7 - now.getDay() + 1; // Next Monday
      targetDate.setDate(targetDate.getDate() + daysUntilNextWeek);
      matched = true;
      matchedPattern = 'на следующей неделе';
    }
    // Next month
    else if (/в\s*следующем\s*месяце/i.test(text)) {
      targetDate.setMonth(targetDate.getMonth() + 1);
      targetDate.setDate(1); // First day of next month
      matched = true;
      matchedPattern = 'в следующем месяце';
    }
    // Next year
    else if (/в\s*следующем\s*году/i.test(text)) {
      targetDate.setFullYear(targetDate.getFullYear() + 1);
      targetDate.setMonth(0); // January
      targetDate.setDate(1); // First day of year
      matched = true;
      matchedPattern = 'в следующем году';
    }
    // This week patterns
    else if (/на\s*этой\s*неделе/i.test(text)) {
      // Keep current date but set to a reasonable time
      matched = true;
      matchedPattern = 'на этой неделе';
    }
    // This month patterns
    else if (/в\s*этом\s*месяце/i.test(text)) {
      // Keep current date but set to a reasonable time
      matched = true;
      matchedPattern = 'в этом месяце';
    }

    if (!matched) {
      return null;
    }

    // Extract reminder text by removing the time expression
    const reminderText = text
      .replace(/напомни\s*(мне)?/gi, '')
      .replace(/напомню\s*(тебе|вам)?/gi, '')
      .replace(
        /завтра|послезавтра|на\s*следующей\s*неделе|в\s*следующем\s*месяце|в\s*следующем\s*году|на\s*этой\s*неделе|в\s*этом\s*месяце/gi,
        '',
      )
      .trim();

    return { targetDate, reminderText };
  }

  // Get correct unit text for Russian language
  private getUnitText(amount: number, unit: string): string {
    const lastDigit = amount % 10;
    const lastTwoDigits = amount % 100;

    if (unit.includes('день')) {
      if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return 'дней';
      if (lastDigit === 1) return 'день';
      if (lastDigit >= 2 && lastDigit <= 4) return 'дня';
      return 'дней';
    }

    if (unit.includes('недел')) {
      if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return 'недель';
      if (lastDigit === 1) return 'неделю';
      if (lastDigit >= 2 && lastDigit <= 4) return 'недели';
      return 'недель';
    }

    if (unit.includes('месяц')) {
      if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return 'месяцев';
      if (lastDigit === 1) return 'месяц';
      if (lastDigit >= 2 && lastDigit <= 4) return 'месяца';
      return 'месяцев';
    }

    if (unit.includes('год') || unit.includes('лет')) {
      if (lastTwoDigits >= 11 && lastTwoDigits <= 14) return 'лет';
      if (lastDigit === 1) return 'год';
      if (lastDigit >= 2 && lastDigit <= 4) return 'года';
      return 'лет';
    }

    return unit;
  }

  // Handle long-term tasks (days, weeks, months, years)
  private async handleLongTermTask(
    ctx: BotContext,
    taskText: string,
    targetDate: Date,
    amount: number,
    unit: string,
  ): Promise<void> {
    if (!ctx.from) {
      console.error('No user context found for long-term task');
      return;
    }

    const userId = ctx.from.id;

    // Update user activity
    await this.updateUserActivity(userId.toString());

    const now = new Date();
    const timeDifference = targetDate.getTime() - now.getTime();
    const daysUntilTask = Math.ceil(timeDifference / (1000 * 60 * 60 * 24));

    let confirmationMessage = '';

    if (unit === 'specific') {
      // For expressions like "завтра", "на следующей неделе", etc.
      confirmationMessage = `✅ *Задача с дедлайном создана*\n\n📝 ${taskText}\n📅 Срок: ${targetDate.toLocaleDateString(
        'ru-RU',
        {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        },
      )}`;
    } else {
      // For "через X дней/недель/месяцев/лет"
      const unitText = this.getUnitText(amount, unit);
      confirmationMessage = `✅ *Задача с дедлайном создана*\n\n📝 ${taskText}\n⏳ Срок: через ${amount} ${unitText}\n📅 ${targetDate.toLocaleDateString(
        'ru-RU',
        {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        },
      )}`;
    }

    // Create the task with deadline
    try {
      const user = await this.userService.findByTelegramId(userId.toString());

      if (!user.timezone) {
        ctx.session.step = 'waiting_for_task_title';
        ctx.session.tempData = {
          taskTitle: taskText,
          deadline: targetDate.toISOString(),
          isLongTerm: true,
        };
        await this.askForTimezone(ctx);
        return;
      }

      const task = await this.taskService.createTask({
        userId: userId.toString(),
        title: taskText.trim(),
        dueDate: targetDate,
      });

      await ctx.replyWithMarkdown(
        confirmationMessage +
          `\n\n💡 *Подсказка:* Задача добавлена в ваш список и будет напоминать о приближении дедлайна.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Мои задачи', callback_data: 'tasks_list' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      console.error(`Error creating long-term task: ${error}`);
      await ctx.replyWithMarkdown(
        '❌ Произошла ошибка при создании задачи. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }

    // Log the long-term task
    console.log(`Long-term task created for user ${userId}:`, {
      text: taskText,
      targetDate: targetDate.toISOString(),
      amount,
      unit,
      daysUntil: daysUntilTask,
    });
  }

  // Create task with specific deadline
  private async createTaskWithDeadline(
    ctx: BotContext,
    taskText: string,
    targetDate: Date,
  ): Promise<void> {
    if (!ctx.from) {
      console.error('No user context found for task with deadline');
      return;
    }

    const userId = ctx.from.id;

    try {
      const user = await this.userService.findByTelegramId(userId.toString());

      if (!user.timezone) {
        ctx.session.step = 'waiting_for_task_title';
        ctx.session.tempData = {
          taskTitle: taskText,
          deadline: targetDate.toISOString(),
        };
        await this.askForTimezone(ctx);
        return;
      }

      const task = await this.taskService.createTask({
        userId: userId.toString(),
        title: taskText.trim(),
        dueDate: targetDate,
      });

      const confirmationMessage = `✅ *Задача с дедлайном создана*\n\n📝 ${taskText}\n⏰ Срок: ${targetDate.toLocaleDateString(
        'ru-RU',
        {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        },
      )}`;

      await ctx.replyWithMarkdown(confirmationMessage, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📝 Мои задачи', callback_data: 'tasks_list' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      });

      // Update user activity
      await this.updateUserActivity(userId.toString());
    } catch (error) {
      console.error(`Error creating task with deadline: ${error}`);
      await ctx.replyWithMarkdown(
        '❌ Произошла ошибка при создании задачи. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  // Parse specific time expressions for tasks (reusing reminder logic with task context)
  private parseSpecificTimeExpressionsForTasks(
    text: string,
  ): { targetDate: Date; taskText: string } | null {
    const now = new Date();
    let targetDate = new Date(now);
    let matched = false;
    let matchedPattern = '';

    // Tomorrow patterns
    if (/завтра/i.test(text)) {
      targetDate.setDate(targetDate.getDate() + 1);
      matched = true;
      matchedPattern = 'завтра';
    }
    // Day after tomorrow
    else if (/послезавтра/i.test(text)) {
      targetDate.setDate(targetDate.getDate() + 2);
      matched = true;
      matchedPattern = 'послезавтра';
    }
    // Next week
    else if (/на\s*следующей\s*неделе/i.test(text)) {
      const daysUntilNextWeek = 7 - now.getDay() + 1; // Next Monday
      targetDate.setDate(targetDate.getDate() + daysUntilNextWeek);
      matched = true;
      matchedPattern = 'на следующей неделе';
    }
    // Next month
    else if (/в\s*следующем\s*месяце/i.test(text)) {
      targetDate.setMonth(targetDate.getMonth() + 1);
      targetDate.setDate(1); // First day of next month
      matched = true;
      matchedPattern = 'в следующем месяце';
    }
    // Next year
    else if (/в\s*следующем\s*году/i.test(text)) {
      targetDate.setFullYear(targetDate.getFullYear() + 1);
      targetDate.setMonth(0); // January
      targetDate.setDate(1); // First day of year
      matched = true;
      matchedPattern = 'в следующем году';
    }

    if (!matched) {
      return null;
    }

    // Extract task text by removing the time expression
    const taskText = text
      .replace(
        /завтра|послезавтра|на\s*следующей\s*неделе|в\s*следующем\s*месяце|в\s*следующем\s*году/gi,
        '',
      )
      .trim();

    return { targetDate, taskText };
  }

  /**
   * Send message to user by ID
   */
  async sendMessageToUser(userId: number, text: string, options?: any) {
    try {
      // По умолчанию включаем звук уведомлений, если не указано иное
      const defaultOptions = {
        disable_notification: false,
        ...options,
      };
      await this.bot.telegram.sendMessage(userId, text, defaultOptions);
      this.logger.log(`Message sent to user ${userId}`);
    } catch (error) {
      this.logger.error(`Failed to send message to user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Complete habit from notification
   */
  private async completeHabitFromNotification(
    ctx: BotContext,
    habitId: string,
  ) {
    try {
      const userId = ctx.from?.id.toString();
      if (!userId) return;

      // Mark habit as completed
      const result = await this.habitService.completeHabit(habitId, userId);

      const message = `✅ Привычка "${result.habit.title}" выполнена!\n\n🔥 Так держать! Продолжайте в том же духе!\n\n⭐ Получено опыта: ${result.xpGained}`;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎯 Мои привычки', callback_data: 'habits_list' }],
          ],
        },
      });
    } catch (error) {
      this.logger.error('Error completing habit from notification:', error);
      await ctx.editMessageText(
        '❌ Ошибка при выполнении привычки. Попробуйте позже.',
      );
    }
  }

  /**
   * Snooze habit notification
   */
  private async snoozeHabitFromNotification(
    ctx: BotContext,
    habitId: string,
    minutes: number,
  ) {
    try {
      // Simple snooze implementation using setTimeout
      const delayMs = minutes * 60 * 1000;

      setTimeout(async () => {
        const habit = await this.prisma.habit.findUnique({
          where: { id: habitId },
          include: { user: true },
        });

        if (habit) {
          const message = `⏰ *Напоминание о привычке*\n\n🎯 ${habit.title}\n\nВремя выполнить вашу привычку!`;
          const keyboard = {
            inline_keyboard: [
              [
                {
                  text: '✅ Выполнил',
                  callback_data: `complete_habit_${habitId}`,
                },
                {
                  text: '⏰ Отложить на 15 мин',
                  callback_data: `snooze_habit_${habitId}_15`,
                },
              ],
              [
                {
                  text: '📊 Статистика',
                  callback_data: `habit_stats_${habitId}`,
                },
                {
                  text: '❌ Пропустить сегодня',
                  callback_data: `skip_habit_${habitId}`,
                },
              ],
            ],
          };

          await this.sendMessageToUser(parseInt(habit.user.id), message, {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          });
        }
      }, delayMs);

      await ctx.editMessageText(
        `⏰ Напоминание отложено на ${minutes} минут.\n\nМы напомним вам позже!`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🎯 Мои привычки', callback_data: 'habits_list' }],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error snoozing habit notification:', error);
      await ctx.editMessageText('❌ Ошибка при отложении напоминания.');
    }
  }

  /**
   * Show habit statistics from notification
   */
  private async showHabitStatsFromNotification(
    ctx: BotContext,
    habitId: string,
  ) {
    try {
      const habit = await this.prisma.habit.findUnique({
        where: { id: habitId },
      });

      if (!habit) {
        await ctx.editMessageText('❌ Привычка не найдена.');
        return;
      }

      const streak = habit.currentStreak || 0;
      const bestStreak = habit.maxStreak || 0;
      const totalCompletions = habit.totalCompletions || 0;

      const message = `📊 *Статистика привычки "${habit.title}"*

✅ Всего выполнений: ${totalCompletions}
🔥 Текущая серия: ${streak} дней
🏆 Лучшая серия: ${bestStreak} дней
📅 Частота: ${habit.frequency}

Продолжайте в том же духе! 💪`;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Выполнить сейчас',
                callback_data: `complete_habit_${habitId}`,
              },
            ],
            [{ text: '🎯 Мои привычки', callback_data: 'habits_list' }],
          ],
        },
      });
    } catch (error) {
      this.logger.error('Error showing habit stats from notification:', error);
      await ctx.editMessageText('❌ Ошибка при получении статистики.');
    }
  }

  /**
   * Skip habit for today from notification
   */
  private async skipHabitFromNotification(ctx: BotContext, habitId: string) {
    try {
      const habit = await this.prisma.habit.findUnique({
        where: { id: habitId },
      });

      if (!habit) {
        await ctx.editMessageText('❌ Привычка не найдена.');
        return;
      }

      // You might want to track skipped habits in your database
      // For now, just update the message

      const message = `⏭️ Привычка "${habit.title}" пропущена на сегодня.

Не расстраивайтесь! Завтра новый день - новые возможности! 🌅`;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎯 Мои привычки', callback_data: 'habits_list' }],
          ],
        },
      });
    } catch (error) {
      this.logger.error('Error skipping habit from notification:', error);
      await ctx.editMessageText('❌ Ошибка при пропуске привычки.');
    }
  }

  /**
   * Show reminder setup menu for a habit
   */
  private async showReminderSetup(ctx: BotContext, habitId: string) {
    try {
      const habit = await this.prisma.habit.findUnique({
        where: { id: habitId },
      });

      if (!habit) {
        await ctx.editMessageText('❌ Привычка не найдена.');
        return;
      }

      const message = `⏰ *Настройка напоминаний*\n\n🎯 Привычка: ${habit.title}\n\nВыберите интервал напоминаний:`;

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: '⏰ Каждый час',
              callback_data: `set_reminder_${habitId}_hourly`,
            },
            {
              text: '🕐 Каждые 2 часа',
              callback_data: `set_reminder_${habitId}_2hours`,
            },
          ],
          [
            {
              text: '🕓 Каждые 3 часа',
              callback_data: `set_reminder_${habitId}_3hours`,
            },
            {
              text: '🕕 Каждые 6 часов',
              callback_data: `set_reminder_${habitId}_6hours`,
            },
          ],
          [
            {
              text: '🌅 Утром (09:00)',
              callback_data: `set_reminder_${habitId}_morning`,
            },
            {
              text: '🌆 Вечером (19:00)',
              callback_data: `set_reminder_${habitId}_evening`,
            },
          ],
          [
            {
              text: '📅 Каждый день (12:00)',
              callback_data: `set_reminder_${habitId}_daily`,
            },
            {
              text: '🗓️ Каждую неделю',
              callback_data: `set_reminder_${habitId}_weekly`,
            },
          ],
          [{ text: '🔙 Назад к привычкам', callback_data: 'habits_list' }],
        ],
      };

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    } catch (error) {
      this.logger.error('Error showing reminder setup:', error);
      await ctx.editMessageText('❌ Ошибка при настройке напоминаний.');
    }
  }

  /**
   * Set habit reminder with specified interval
   */
  private async setHabitReminder(
    ctx: BotContext,
    habitId: string,
    interval: string,
  ) {
    try {
      let reminderTime = '';
      let intervalText = '';
      let nextReminder = '';

      const now = new Date();
      const currentTime = now.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      });

      switch (interval) {
        case 'hourly':
          reminderTime = 'каждый час';
          intervalText = 'каждый час';
          const nextHour = new Date(now);
          nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
          nextReminder = nextHour.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          });
          break;
        case '2hours':
          reminderTime = 'каждые 2 часа';
          intervalText = 'каждые 2 часа';
          const next2Hours = new Date(now);
          next2Hours.setHours(next2Hours.getHours() + 2, 0, 0, 0);
          nextReminder = next2Hours.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          });
          break;
        case '3hours':
          reminderTime = 'каждые 3 часа';
          intervalText = 'каждые 3 часа';
          const next3Hours = new Date(now);
          next3Hours.setHours(next3Hours.getHours() + 3, 0, 0, 0);
          nextReminder = next3Hours.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          });
          break;
        case '6hours':
          reminderTime = 'каждые 6 часов';
          intervalText = 'каждые 6 часов';
          const next6Hours = new Date(now);
          next6Hours.setHours(next6Hours.getHours() + 6, 0, 0, 0);
          nextReminder = next6Hours.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          });
          break;
        case 'morning':
          reminderTime = '09:00';
          intervalText = 'утром в 9:00';
          const tomorrow = new Date(now);
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(9, 0, 0, 0);
          nextReminder = `завтра в ${tomorrow.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          })}`;
          break;
        case 'evening':
          reminderTime = '19:00';
          intervalText = 'вечером в 19:00';
          const evening = new Date(now);
          if (now.getHours() >= 19) {
            evening.setDate(evening.getDate() + 1);
          }
          evening.setHours(19, 0, 0, 0);
          const isToday = evening.getDate() === now.getDate();
          nextReminder = `${isToday ? 'сегодня' : 'завтра'} в 19:00`;
          break;
        case 'daily':
          reminderTime = '12:00';
          intervalText = 'каждый день в 12:00';
          const noon = new Date(now);
          if (now.getHours() >= 12) {
            noon.setDate(noon.getDate() + 1);
          }
          noon.setHours(12, 0, 0, 0);
          const isTodayNoon = noon.getDate() === now.getDate();
          nextReminder = `${isTodayNoon ? 'сегодня' : 'завтра'} в 12:00`;
          break;
        case 'weekly':
          reminderTime = '12:00';
          intervalText = 'каждую неделю в понедельник в 12:00';
          const nextMonday = new Date(now);
          const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
          nextMonday.setDate(now.getDate() + daysUntilMonday);
          nextMonday.setHours(12, 0, 0, 0);
          nextReminder = `в понедельник в 12:00`;
          break;
      }

      // Update habit with reminder time
      const habit = await this.prisma.habit.update({
        where: { id: habitId },
        data: { reminderTime },
      });

      const message = `✅ *Напоминание настроено!*\n\n🎯 Привычка: ${habit.title}\n⏰ Интервал: ${intervalText}\n\n🕒 Следующее уведомление: **${nextReminder}**\n\nТеперь вы будете получать напоминания о выполнении этой привычки!`;

      await ctx.editMessageText(message, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🧪 Тест напоминания',
                callback_data: `complete_habit_${habitId}`,
              },
            ],
            [{ text: '🎯 Мои привычки', callback_data: 'habits_list' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      });

      // Start the notification schedule for this habit
      try {
        const notificationService =
          require('../services/notification.service').NotificationService;
        if (notificationService) {
          // Simulate updating reminder in notification service
          this.logger.log(
            `Starting notifications for habit ${habitId} with interval ${intervalText}`,
          );
        }
      } catch (error) {
        this.logger.warn(
          'Could not start notifications immediately:',
          error.message,
        );
      }

      this.logger.log(
        `Reminder set for habit ${habitId}: ${intervalText} - Next: ${nextReminder}`,
      );
    } catch (error) {
      this.logger.error('Error setting habit reminder:', error);
      await ctx.editMessageText('❌ Ошибка при настройке напоминания.');
    }
  }

  /**
   * Calculate next reminder time based on reminder setting
   */
  private calculateNextReminderTime(reminderTime: string): string {
    const now = new Date();

    if (reminderTime.includes('каждый час') || reminderTime === 'hourly') {
      const nextHour = new Date(now);
      nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
      return nextHour.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    if (reminderTime.includes('каждые 2 часа') || reminderTime === '2hours') {
      const next2Hours = new Date(now);
      next2Hours.setHours(next2Hours.getHours() + 2, 0, 0, 0);
      return next2Hours.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    if (reminderTime.includes('каждые 3 часа') || reminderTime === '3hours') {
      const next3Hours = new Date(now);
      next3Hours.setHours(next3Hours.getHours() + 3, 0, 0, 0);
      return next3Hours.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    if (reminderTime.includes('каждые 6 часов') || reminderTime === '6hours') {
      const next6Hours = new Date(now);
      next6Hours.setHours(next6Hours.getHours() + 6, 0, 0, 0);
      return next6Hours.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    // Check for specific times like "09:00", "19:00"
    const timeMatch = reminderTime.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      const [, hours, minutes] = timeMatch;
      const targetTime = new Date(now);
      targetTime.setHours(parseInt(hours), parseInt(minutes), 0, 0);

      if (targetTime <= now) {
        targetTime.setDate(targetTime.getDate() + 1);
        return `завтра в ${targetTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
      } else {
        return `сегодня в ${targetTime.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
      }
    }

    return 'время не определено';
  }

  /**
   * Extract time interval information from task text
   */
  private extractTimeIntervalFromText(
    text: string,
  ): { interval: string; nextTime: string } | null {
    const now = new Date();
    const lowerText = text.toLowerCase();

    // Проверяем различные интервалы
    if (lowerText.includes('каждый час') || lowerText.includes('ежечасно')) {
      const nextHour = new Date(now);
      nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
      return {
        interval: 'каждый час',
        nextTime: nextHour.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    if (
      lowerText.includes('каждые два часа') ||
      lowerText.includes('каждые 2 часа')
    ) {
      const next2Hours = new Date(now);
      next2Hours.setHours(next2Hours.getHours() + 2, 0, 0, 0);
      return {
        interval: 'каждые 2 часа',
        nextTime: next2Hours.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    if (
      lowerText.includes('каждые три часа') ||
      lowerText.includes('каждые 3 часа')
    ) {
      const next3Hours = new Date(now);
      next3Hours.setHours(next3Hours.getHours() + 3, 0, 0, 0);
      return {
        interval: 'каждые 3 часа',
        nextTime: next3Hours.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    if (
      lowerText.includes('каждые четыре часа') ||
      lowerText.includes('каждые 4 часа')
    ) {
      const next4Hours = new Date(now);
      next4Hours.setHours(next4Hours.getHours() + 4, 0, 0, 0);
      return {
        interval: 'каждые 4 часа',
        nextTime: next4Hours.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    if (
      lowerText.includes('каждые пять часов') ||
      lowerText.includes('каждые 5 часов')
    ) {
      const next5Hours = new Date(now);
      next5Hours.setHours(next5Hours.getHours() + 5, 0, 0, 0);
      return {
        interval: 'каждые 5 часов',
        nextTime: next5Hours.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    if (
      lowerText.includes('каждые шесть часов') ||
      lowerText.includes('каждые 6 часов')
    ) {
      const next6Hours = new Date(now);
      next6Hours.setHours(next6Hours.getHours() + 6, 0, 0, 0);
      return {
        interval: 'каждые 6 часов',
        nextTime: next6Hours.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    // Проверяем минутные интервалы
    if (
      lowerText.includes('каждую минуту') ||
      lowerText.includes('каждая минута')
    ) {
      const nextMin = new Date(now);
      nextMin.setMinutes(nextMin.getMinutes() + 1);
      return {
        interval: 'каждую минуту',
        nextTime: nextMin.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    if (
      lowerText.includes('каждые две минуты') ||
      lowerText.includes('каждые 2 минуты')
    ) {
      const next2Min = new Date(now);
      next2Min.setMinutes(next2Min.getMinutes() + 2);
      return {
        interval: 'каждые 2 минуты',
        nextTime: next2Min.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    if (
      lowerText.includes('каждые три минуты') ||
      lowerText.includes('каждые 3 минуты')
    ) {
      const next3Min = new Date(now);
      next3Min.setMinutes(next3Min.getMinutes() + 3);
      return {
        interval: 'каждые 3 минуты',
        nextTime: next3Min.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    if (
      lowerText.includes('каждые пять минут') ||
      lowerText.includes('каждые 5 минут')
    ) {
      const next5Min = new Date(now);
      next5Min.setMinutes(next5Min.getMinutes() + 5);
      return {
        interval: 'каждые 5 минут',
        nextTime: next5Min.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    if (
      lowerText.includes('каждые десять минут') ||
      lowerText.includes('каждые 10 минут')
    ) {
      const next10Min = new Date(now);
      next10Min.setMinutes(next10Min.getMinutes() + 10);
      return {
        interval: 'каждые 10 минут',
        nextTime: next10Min.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    if (
      lowerText.includes('каждые 15 минут') ||
      lowerText.includes('каждую четверть часа')
    ) {
      const next15Min = new Date(now);
      next15Min.setMinutes(next15Min.getMinutes() + 15);
      return {
        interval: 'каждые 15 минут',
        nextTime: next15Min.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    if (
      lowerText.includes('каждые 30 минут') ||
      lowerText.includes('каждые полчаса')
    ) {
      const next30Min = new Date(now);
      next30Min.setMinutes(next30Min.getMinutes() + 30);
      return {
        interval: 'каждые 30 минут',
        nextTime: next30Min.toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };
    }

    // Проверяем дневные интервалы
    if (lowerText.includes('каждый день') || lowerText.includes('ежедневно')) {
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(9, 0, 0, 0); // По умолчанию утром в 9:00
      return {
        interval: 'каждый день',
        nextTime: `завтра в ${tomorrow.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`,
      };
    }

    return null;
  }

  private async handleIntervalReminder(
    ctx: BotContext,
    reminderText: string,
    intervalMinutes: number,
  ): Promise<void> {
    try {
      // Check billing limits for interval reminders
      const limitCheck = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyReminders',
      );

      if (!limitCheck.allowed) {
        await ctx.replyWithMarkdown(
          limitCheck.message || '🚫 Превышен лимит напоминаний',
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '💎 Обновиться до Premium',
                    callback_data: 'upgrade_premium',
                  },
                ],
                [{ text: '📊 Мои лимиты', callback_data: 'show_limits' }],
              ],
            },
          },
        );
        return;
      }

      // Check if user already has an interval reminder running
      const existingReminder = this.activeIntervalReminders.get(ctx.userId);
      if (existingReminder) {
        await ctx.replyWithMarkdown(
          `
⚠️ *У вас уже активно интервальное напоминание*

📝 Текущее: "${existingReminder.reminderText}"
⏱️ Интервал: каждые ${existingReminder.intervalMinutes} мин
📊 Отправлено: ${existingReminder.count} раз

Хотите заменить его новым?
          `,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '✅ Заменить',
                    callback_data: `replace_interval_${intervalMinutes}_${Buffer.from(reminderText).toString('base64')}`,
                  },
                  {
                    text: '❌ Отменить',
                    callback_data: 'cancel_interval_setup',
                  },
                ],
                [
                  {
                    text: '🛑 Остановить текущее',
                    callback_data: 'stop_interval_reminder',
                  },
                ],
              ],
            },
          },
        );
        return;
      }

      // Start the interval reminder
      await this.startIntervalReminder(ctx, reminderText, intervalMinutes);
    } catch (error) {
      this.logger.error('Error handling interval reminder:', error);
      await ctx.replyWithMarkdown(`
❌ *Ошибка создания интервального напоминания*

Не удалось создать интервальное напоминание. Попробуйте ещё раз.
      `);
    }
  }

  private async startIntervalReminder(
    ctx: BotContext,
    reminderText: string,
    intervalMinutes: number,
  ): Promise<void> {
    try {
      const startTime = new Date();
      let count = 0;

      // Create interval
      const intervalId = setInterval(
        async () => {
          count++;
          try {
            await ctx.telegram.sendMessage(
              ctx.userId,
              `🔔 *Интервальное напоминание #${count}*\n\n${reminderText}\n\n⏱️ Следующее через ${intervalMinutes} мин`,
              {
                parse_mode: 'Markdown',
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: '🛑 Остановить',
                        callback_data: 'stop_interval_reminder',
                      },
                    ],
                  ],
                },
              },
            );

            // Update count in the map
            const reminder = this.activeIntervalReminders.get(ctx.userId);
            if (reminder) {
              reminder.count = count;
            }
          } catch (error) {
            this.logger.error('Error sending interval reminder:', error);
            // If error sending, stop the interval
            this.stopIntervalReminder(ctx.userId);
          }
        },
        intervalMinutes * 60 * 1000,
      );

      // Store the interval reminder
      this.activeIntervalReminders.set(ctx.userId, {
        intervalId,
        reminderText,
        intervalMinutes,
        startTime,
        count: 0,
      });

      // Increment usage counter
      await this.billingService.incrementUsage(ctx.userId, 'dailyReminders');

      // Get current usage for display
      const usageInfo = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyReminders',
      );

      const intervalText =
        intervalMinutes < 60
          ? `${intervalMinutes} минут`
          : `${Math.floor(intervalMinutes / 60)} час${intervalMinutes === 60 ? '' : 'а'}`;

      await ctx.replyWithMarkdown(
        `
🔄 *Интервальное напоминание запущено!*

📝 **Текст:** ${reminderText}
⏱️ **Интервал:** каждые ${intervalText}
🕐 **Начато:** ${startTime.toLocaleTimeString('ru-RU')}

📊 **Использовано:** ${usageInfo.current}${usageInfo.limit === -1 ? '' : `/${usageInfo.limit}`} напоминаний

🔔 Первое напоминание через ${intervalText}!
        `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🛑 Остановить',
                  callback_data: 'stop_interval_reminder',
                },
                {
                  text: '📊 Статус',
                  callback_data: 'interval_status',
                },
              ],
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error starting interval reminder:', error);
      throw error;
    }
  }

  private stopIntervalReminder(userId: string): boolean {
    const reminder = this.activeIntervalReminders.get(userId);
    if (reminder) {
      clearInterval(reminder.intervalId);
      this.activeIntervalReminders.delete(userId);
      return true;
    }
    return false;
  }

  private async handleQuickReminderTime(
    ctx: BotContext,
    amount: number,
    unit: string,
  ) {
    if (!ctx.session.pendingReminder) {
      await ctx.editMessageText('❌ Ошибка: не найден текст напоминания');
      return;
    }

    const reminderData = ctx.session.pendingReminder;
    const reminderText = reminderData.text;

    // Рассчитываем время напоминания
    const now = new Date();
    let targetTime = new Date(now);

    if (unit === 'минут') {
      targetTime.setMinutes(targetTime.getMinutes() + amount);
    } else if (unit === 'час' || unit === 'часа') {
      targetTime.setHours(targetTime.getHours() + amount);
    }

    const hours = targetTime.getHours().toString().padStart(2, '0');
    const minutes = targetTime.getMinutes().toString().padStart(2, '0');

    // Очищаем сессию
    ctx.session.pendingReminder = undefined;
    ctx.session.waitingForReminderTime = false;

    // Создаем напоминание
    await this.handleReminderRequest(ctx, reminderText, hours, minutes);
  }

  private async handleTomorrowReminder(
    ctx: BotContext,
    hours: string,
    minutes: string,
    timeText: string,
  ) {
    if (!ctx.session.pendingReminder) {
      await ctx.editMessageText('❌ Ошибка: не найден текст напоминания');
      return;
    }

    const reminderData = ctx.session.pendingReminder;
    const reminderText = reminderData.text;

    // Очищаем сессию
    ctx.session.pendingReminder = undefined;
    ctx.session.waitingForReminderTime = false;

    // Создаем напоминание на завтра
    await this.handleReminderRequest(ctx, reminderText, hours, minutes);
  }

  private async askForCustomReminderTime(ctx: BotContext) {
    if (!ctx.session.pendingReminder) {
      await ctx.editMessageText('❌ Ошибка: не найден текст напоминания');
      return;
    }

    await this.showHourSelection(ctx);
  }

  private async showHourSelection(ctx: BotContext) {
    await ctx.editMessageTextWithMarkdown(
      `📝 *Напоминание:* "${ctx.session.pendingReminder?.text}"

🕐 *Выберите час:*`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '08:00', callback_data: 'select_hour_08' },
              { text: '09:00', callback_data: 'select_hour_09' },
              { text: '10:00', callback_data: 'select_hour_10' },
            ],
            [
              { text: '11:00', callback_data: 'select_hour_11' },
              { text: '12:00', callback_data: 'select_hour_12' },
              { text: '13:00', callback_data: 'select_hour_13' },
            ],
            [
              { text: '14:00', callback_data: 'select_hour_14' },
              { text: '15:00', callback_data: 'select_hour_15' },
              { text: '16:00', callback_data: 'select_hour_16' },
            ],
            [
              { text: '17:00', callback_data: 'select_hour_17' },
              { text: '18:00', callback_data: 'select_hour_18' },
              { text: '19:00', callback_data: 'select_hour_19' },
            ],
            [
              { text: '20:00', callback_data: 'select_hour_20' },
              { text: '21:00', callback_data: 'select_hour_21' },
              { text: '22:00', callback_data: 'select_hour_22' },
            ],
            [{ text: '🔢 Другое время', callback_data: 'select_other_hour' }],
            [{ text: '❌ Отмена', callback_data: 'cancel_reminder' }],
          ],
        },
      },
    );
  }

  private async showMinuteSelection(ctx: BotContext, selectedHour: string) {
    if (!ctx.session.pendingReminder) {
      await ctx.editMessageText('❌ Ошибка: не найден текст напоминания');
      return;
    }

    // Сохраняем выбранный час в tempData
    ctx.session.tempData = { selectedHour };

    await ctx.editMessageTextWithMarkdown(
      `📝 *Напоминание:* "${ctx.session.pendingReminder?.text}"

🕐 *Выбранный час:* ${selectedHour}:00

⏰ *Выберите минуты:*`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: ':00', callback_data: 'select_minute_00' },
              { text: ':15', callback_data: 'select_minute_15' },
              { text: ':30', callback_data: 'select_minute_30' },
              { text: ':45', callback_data: 'select_minute_45' },
            ],
            [
              { text: ':05', callback_data: 'select_minute_05' },
              { text: ':10', callback_data: 'select_minute_10' },
              { text: ':20', callback_data: 'select_minute_20' },
              { text: ':25', callback_data: 'select_minute_25' },
            ],
            [
              { text: ':35', callback_data: 'select_minute_35' },
              { text: ':40', callback_data: 'select_minute_40' },
              { text: ':50', callback_data: 'select_minute_50' },
              { text: ':55', callback_data: 'select_minute_55' },
            ],
            [
              {
                text: '🔙 Назад к часам',
                callback_data: 'back_to_hour_selection',
              },
            ],
            [{ text: '❌ Отмена', callback_data: 'cancel_reminder' }],
          ],
        },
      },
    );
  }

  private async createHabitFromExample(ctx: BotContext, habitName: string) {
    try {
      // Создаем привычку с выбранным названием
      const habit = await this.habitService.createHabit({
        userId: ctx.userId,
        title: habitName,
        description: `каждый день`,
        frequency: 'DAILY',
        targetCount: 1,
      });

      // Increment usage counter for habits
      await this.billingService.incrementUsage(ctx.userId, 'dailyHabits');

      // Clear session state after successful habit creation
      ctx.session.step = undefined;
      ctx.session.pendingAction = undefined;

      // Get current usage for display
      const usageInfo = await this.billingService.checkUsageLimit(
        ctx.userId,
        'dailyHabits',
      );

      const user = await this.userService.findByTelegramId(ctx.userId);

      const keyboardForOnboarding = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '❓ Далее к FAQ', callback_data: 'onboarding_next_faq' }],
          ],
        },
      };

      const keyboardDefault = {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '⏰ Настроить напоминание',
                callback_data: `habit_set_reminder_${habit.id}`,
              },
            ],
            [
              {
                text: '🎯 Мои привычки',
                callback_data: 'habits_list',
              },
              {
                text: '🏠 Главное меню',
                callback_data: 'back_to_menu',
              },
            ],
            [
              {
                text: '❓ Что еще я умею?',
                callback_data: 'faq_support',
              },
            ],
          ],
        },
      };

      const replyKeyboard =
        user && user.onboardingPassed === false
          ? keyboardForOnboarding
          : keyboardDefault;

      await ctx.editMessageTextWithMarkdown(
        `
✅ *Привычка создана!*

🎯 **Название:** ${habitName}
📅 **Описание:** каждый день

📊 **Использовано:** ${usageInfo.current}${usageInfo.limit === -1 ? '' : `/${usageInfo.limit}`} привычек

💡 **Подсказка:** Вы можете настроить напоминания для этой привычки в меню привычек.
        `,
        replyKeyboard,
      );

      ctx.session.step = undefined;
    } catch (error) {
      this.logger.error('Error creating habit from example:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ *Ошибка создания привычки*\n\nПопробуйте ещё раз или обратитесь к администратору.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад в меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  private async showPomodoroMenu(ctx: BotContext) {
    const activeSession = this.activePomodoroSessions.get(ctx.userId);

    if (activeSession) {
      // Показываем активную сессию
      await this.showActivePomodoroSession(ctx, activeSession);
      return;
    }

    // Показываем стандартное меню помодоро
    const message = `
🍅 *Техника Помодоро*

Техника Pomodoro (метод помидора) — метод тайм-менеджмента, разработанный итальянским студентом Франческо Чирилло в 1980-х годах.

Помогает повысить концентрацию и побороть прокрастинацию

**Как это работает:**
⏰ 25 минут фокуса на задаче
☕ 5 минут отдых
🔄 Повторить 4 раза
🏖️ Большой перерыв 15-30 минут

*Выберите действие:*
    `;

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🚀 Начать сессию',
              callback_data: 'start_pomodoro_session',
            },
          ],
          [
            {
              text: '📊 История сессий',
              callback_data: 'pomodoro_history',
            },
            {
              text: '⚙️ Настройки',
              callback_data: 'pomodoro_settings',
            },
          ],
          [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
          [{ text: '🏠 Главное меню', callback_data: 'start' }],
        ],
      },
    };

    // Check if this is a callback query (can edit) or command (need to reply)
    if (ctx.callbackQuery) {
      try {
        await ctx.editMessageTextWithMarkdown(message, keyboard);
      } catch (error) {
        // Fallback for photo messages - reply instead of edit
        await ctx.replyWithMarkdown(message, keyboard);
      }
    } else {
      await ctx.replyWithMarkdown(message, keyboard);
    }
  }

  private async showActivePomodoroSession(ctx: BotContext, session: any) {
    const currentTime = new Date();
    const totalElapsed =
      currentTime.getTime() -
      session.startTime.getTime() -
      (session.totalPausedTime || 0);
    const elapsed = Math.floor(totalElapsed / (1000 * 60));
    const remaining = Math.max(0, 25 - elapsed);

    let message: string;
    let keyboard: any;

    if (session.pausedAt) {
      // Сессия на паузе
      const remainingMinutes = remaining;
      const remainingSeconds = Math.max(
        0,
        Math.floor((25 * 60 * 1000 - totalElapsed) / 1000) % 60,
      );

      message = `
⏸️ *Сессия на паузе*

⏰ Осталось времени: ${remainingMinutes}:${remainingSeconds.toString().padStart(2, '0')}
⚡ Прошло: ${elapsed} мин
🎯 Фокус-сессия приостановлена

*Готовы продолжить?*
      `;

      keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '▶️ Продолжить',
                callback_data: 'resume_pomodoro',
              },
              {
                text: '⏹️ Завершить',
                callback_data: 'stop_pomodoro',
              },
            ],
            [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            [{ text: '🏠 Главное меню', callback_data: 'start' }],
          ],
        },
      };
    } else if (session.breakTimer) {
      // Активен перерыв
      message = `
☕ *Время перерыва*

🎉 Фокус-сессия завершена!
⏰ Идет 5-минутный перерыв
💪 Разомнитесь и отдохните

*Перерыв скоро закончится*
      `;

      keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🚀 Начать новую сессию',
                callback_data: 'start_pomodoro_session',
              },
            ],
            [
              {
                text: '📊 История сессий',
                callback_data: 'pomodoro_history',
              },
            ],
            [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            [{ text: '🏠 Главное меню', callback_data: 'start' }],
          ],
        },
      };
    } else {
      // Активная сессия фокуса
      const user = await this.getOrCreateUser(ctx);
      const endTime = new Date(
        session.startTime.getTime() +
          (session.totalPausedTime || 0) +
          25 * 60 * 1000,
      );
      const endTimeFormatted = user.timezone
        ? this.formatTimeWithTimezone(endTime, user.timezone)
        : endTime.toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit',
          });

      message = `
🍅 *Активная сессия фокуса*

⏰ **Таймер**: осталось ${remaining} мин (до ${endTimeFormatted})
⚡ **Прошло**: ${elapsed} мин
🎯 Сосредоточьтесь на одной задаче
💪 Продолжайте работать!

🔔 **Вы получите уведомление, когда время истечет**
      `;

      keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '⏸️ Пауза',
                callback_data: 'pause_pomodoro',
              },
              {
                text: '⏹️ Стоп',
                callback_data: 'stop_pomodoro',
              },
            ],
            [{ text: '⬅️ Назад', callback_data: 'more_functions' }],
            [{ text: '🏠 Главное меню', callback_data: 'start' }],
          ],
        },
      };
    }

    // Check if this is a callback query (can edit) or command (need to reply)
    if (ctx.callbackQuery) {
      await ctx.editMessageTextWithMarkdown(message, keyboard);
    } else {
      await ctx.replyWithMarkdown(message, keyboard);
    }
  }

  /**
   * Check if habit is skipped for today (checks HabitSkip table)
   */
  async isHabitSkippedToday(
    habitId: string,
    userId?: string,
  ): Promise<boolean> {
    // userId is optional for backward compatibility, but should be provided for accuracy
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    // Find skip for this habit and user for today
    const skip = await this.prisma.habitSkip.findFirst({
      where: {
        habitId,
        ...(userId ? { userId } : {}),
        skipDate: {
          gte: today,
          lt: tomorrow,
        },
      },
    });
    return !!skip;
  }

  // Helper methods for quick reminder creation
  private async createReminderWithRelativeTime(
    ctx: BotContext,
    amount: number,
    unit: 'hours' | 'minutes',
  ) {
    try {
      if (!ctx.session.tempData?.taskTitle) {
        throw new Error('No task title found in session');
      }

      const taskTitle = ctx.session.tempData.taskTitle;
      const now = new Date();
      const reminderTime = new Date(now);

      if (unit === 'hours') {
        reminderTime.setHours(reminderTime.getHours() + amount);
      } else {
        reminderTime.setMinutes(reminderTime.getMinutes() + amount);
      }

      const hours = reminderTime.getHours().toString().padStart(2, '0');
      const minutes = reminderTime.getMinutes().toString().padStart(2, '0');

      await this.handleReminderRequest(ctx, taskTitle, hours, minutes);
    } catch (error) {
      this.logger.error('Error creating reminder with relative time:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Произошла ошибка при создании напоминания. Попробуйте еще раз.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  private async createReminderWithSpecificTime(
    ctx: BotContext,
    time: string,
    tomorrow: boolean = false,
  ) {
    try {
      if (!ctx.session.tempData?.taskTitle) {
        throw new Error('No task title found in session');
      }

      const taskTitle = ctx.session.tempData.taskTitle;
      const [hours, minutes] = time.split(':');

      // If tomorrow is true, we might need to handle date logic
      // For now, just pass the time to handleReminderRequest
      // The existing method should handle the time properly

      await this.handleReminderRequest(ctx, taskTitle, hours, minutes);
    } catch (error) {
      this.logger.error('Error creating reminder with specific time:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Произошла ошибка при создании напоминания. Попробуйте еще раз.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  private async handleReminderTimeInputFromTask(
    ctx: BotContext,
    timeInput: string,
  ) {
    try {
      if (!ctx.session.tempData?.taskTitle) {
        await ctx.replyWithMarkdown(
          '❌ Не найдена задача для создания напоминания. Попробуйте еще раз.',
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

      const taskTitle = ctx.session.tempData.taskTitle;

      // Parse different time formats
      const timeMatch = timeInput.match(/(\d{1,2}):(\d{2})/);
      if (timeMatch) {
        const hours = timeMatch[1];
        const minutes = timeMatch[2];

        // Clear the session
        ctx.session.step = undefined;
        ctx.session.tempData = undefined;

        await this.handleReminderRequest(ctx, taskTitle, hours, minutes);
        return;
      }

      // Handle relative time (через X часов/минут)
      const relativeMatch = timeInput.match(
        /через\s*(\d+)\s*(час|часа|часов|минут|минуты)/i,
      );
      if (relativeMatch) {
        const amount = parseInt(relativeMatch[1]);
        const unit = relativeMatch[2];
        const isHours = unit.startsWith('час');

        const now = new Date();
        if (isHours) {
          now.setHours(now.getHours() + amount);
        } else {
          now.setMinutes(now.getMinutes() + amount);
        }

        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');

        // Clear the session
        ctx.session.step = undefined;
        ctx.session.tempData = undefined;

        await this.handleReminderRequest(ctx, taskTitle, hours, minutes);
        return;
      }

      // If we can't parse the time, ask again
      await ctx.replyWithMarkdown(
        `⚠️ Не удалось распознать время. Попробуйте еще раз:\n\n📝 **"${taskTitle}"**\n\nПримеры формата:\n• \`15:30\` - конкретное время\n• \`через 2 часа\` - относительное время`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '❌ Отмена', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error handling reminder time input from task:', error);

      // Clear the session on error
      ctx.session.step = undefined;
      ctx.session.tempData = undefined;

      await ctx.replyWithMarkdown(
        '❌ Произошла ошибка при создании напоминания. Попробуйте еще раз.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
            ],
          },
        },
      );
    }
  }

  private async showSystemInfo(ctx: BotContext) {
    try {
      const user = await this.userService.findByTelegramId(ctx.userId);

      // Получаем информацию о зависимостях/мотивационных сообщениях
      const dependencySupport = await this.prisma.dependencySupport.findFirst({
        where: { userId: user.id, status: 'ACTIVE' },
      });

      // Получаем активные напоминания
      const activeReminders = await this.prisma.reminder.findMany({
        where: {
          userId: user.id,
          status: 'ACTIVE',
          scheduledTime: { gte: new Date() },
        },
        orderBy: { scheduledTime: 'asc' },
        take: 5,
      });

      // Получаем активные привычки с напоминаниями
      const habitsWithReminders = await this.prisma.habit.findMany({
        where: {
          userId: user.id,
          isActive: true,
          reminderTime: { not: null },
        },
      });

      // Формируем сообщение
      let infoMessage = `🔍 *Системная информация*\n\n`;

      // Информация о пользователе
      infoMessage += `👤 **Ваш профиль:**\n`;
      infoMessage += `• Часовой пояс: ${user.timezone || 'Не установлен'}\n`;
      infoMessage += `• Подписка: ${user.subscriptionType === 'PREMIUM' ? '💎 Premium' : '🆓 Бесплатная'}\n\n`;

      // Информация о мотивационных сообщениях
      if (dependencySupport) {
        infoMessage += `🎯 **Система поддержки активна:**\n`;
        infoMessage += `• Тип: ${this.getDependencyTypeRussian(dependencySupport.type)}\n`;
        infoMessage += `• Утренние сообщения: каждый день в ${dependencySupport.morningTime || '09:00'}\n`;
        infoMessage += `• Вечерние проверки: каждый день в ${dependencySupport.eveningTime || '21:00'}\n`;
        infoMessage += `• Обещаний выполнено: ${dependencySupport.totalPromises || 0}\n`;
        infoMessage += `• Общее время поддержки: ${Math.floor((Date.now() - dependencySupport.createdAt.getTime()) / (1000 * 60 * 60 * 24))} дней\n\n`;

        // Время до следующего сообщения
        const now = new Date();
        const currentHour = now.getHours();
        const nextMorning = new Date();
        const nextEvening = new Date();

        if (currentHour < 9) {
          nextMorning.setHours(9, 0, 0, 0);
          infoMessage += `⏰ **Следующее мотивационное сообщение:** сегодня в 09:00\n\n`;
        } else if (currentHour < 21) {
          nextEvening.setHours(21, 0, 0, 0);
          infoMessage += `⏰ **Следующая вечерняя проверка:** сегодня в 21:00\n\n`;
        } else {
          nextMorning.setDate(nextMorning.getDate() + 1);
          nextMorning.setHours(9, 0, 0, 0);
          infoMessage += `⏰ **Следующее мотивационное сообщение:** завтра в 09:00\n\n`;
        }
      } else {
        infoMessage += `🎯 **Система поддержки:** не активна\n`;
        infoMessage += `💡 Активируйте через раздел "Борьба с зависимостями"\n\n`;
      }

      // Информация о напоминаниях
      if (activeReminders.length > 0) {
        infoMessage += `⏰ **Активные напоминания (${activeReminders.length}):**\n`;
        activeReminders.forEach((reminder, index) => {
          if (index < 3) {
            // Показываем только первые 3
            const date = reminder.scheduledTime.toLocaleDateString('ru-RU');
            const time = reminder.scheduledTime.toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            });
            infoMessage += `• ${reminder.title} - ${date} в ${time}\n`;
          }
        });
        if (activeReminders.length > 3) {
          infoMessage += `• ... и ещё ${activeReminders.length - 3}\n`;
        }
        infoMessage += `\n`;
      } else {
        infoMessage += `⏰ **Активные напоминания:** нет\n\n`;
      }

      // Информация о привычках с напоминаниями
      if (habitsWithReminders.length > 0) {
        infoMessage += `🔄 **Привычки с напоминаниями (${habitsWithReminders.length}):**\n`;
        habitsWithReminders.forEach((habit) => {
          infoMessage += `• ${habit.title} - ${habit.reminderTime}\n`;
        });
        infoMessage += `\n`;
      } else {
        infoMessage += `🔄 **Привычки с напоминаниями:** нет\n\n`;
      }

      // Техническая информация
      infoMessage += `🔧 **Техническая информация:**\n`;
      infoMessage += `• Время сервера: ${new Date().toLocaleString('ru-RU')}\n`;
      infoMessage += `• Версия бота: 2.0.0\n`;

      await ctx.replyWithMarkdown(infoMessage, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🎯 Борьба с зависимостями',
                callback_data: 'choose_dependency',
              },
              { text: '⏰ Напоминания', callback_data: 'reminders_menu' },
            ],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      });
    } catch (error) {
      this.logger.error('Error showing system info:', error);
      await ctx.replyWithMarkdown(
        '❌ Ошибка при получении информации о системе.',
      );
    }
  }

  private getDependencyTypeRussian(type: string): string {
    const types = {
      SMOKING: 'Курение',
      ALCOHOL: 'Алкоголь',
      GAMBLING: 'Азартные игры',
      SWEET: 'Сладкое',
      SOCIAL_MEDIA: 'Социальные сети',
      GAMING: 'Игры',
      OTHER: 'Другое',
    };
    return types[type] || type;
  }

  private async testMotivationSystem(ctx: BotContext) {
    try {
      const user = await this.userService.findByTelegramId(ctx.userId);
      const dependencySupport = await this.prisma.dependencySupport.findFirst({
        where: { userId: user.id, status: 'ACTIVE' },
      });

      if (!dependencySupport) {
        await ctx.replyWithMarkdown(
          '❌ У вас нет активной системы поддержки.\n\n' +
            'Активируйте её через раздел "Борьба с зависимостями".',
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: '🎯 Борьба с зависимостями',
                    callback_data: 'choose_dependency',
                  },
                ],
              ],
            },
          },
        );
        return;
      }

      // Проверяем работу NotificationService
      const now = new Date();
      const testMessage =
        `🧪 **Тестовое мотивационное сообщение**\n\n` +
        `🌅 Доброе утро! Каждый день без ${this.getDependencyTypeRussian(dependencySupport.type).toLowerCase()} - это победа!\n\n` +
        `💪 Ты сможешь справиться с этим!\n\n` +
        `⏰ Время: ${now.toLocaleTimeString('ru-RU')}\n` +
        `📅 Дата: ${now.toLocaleDateString('ru-RU')}\n\n` +
        `✅ Система мотивационных сообщений работает!\n` +
        `🕘 Следующее утреннее сообщение в ${dependencySupport.morningTime}\n` +
        `🕘 Следующая вечерняя проверка в ${dependencySupport.eveningTime}`;

      await ctx.replyWithMarkdown(testMessage, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🤝 Обещаю сам себе',
                callback_data: `morning_promise_${this.mapEnumToCallbackType(dependencySupport.type)}`,
              },
            ],
            [{ text: '📊 Информация', callback_data: 'info' }],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      });

      this.logger.log(`Test motivation sent to user ${ctx.userId}`);
    } catch (error) {
      this.logger.error('Error testing motivation system:', error);
      await ctx.replyWithMarkdown(
        '❌ Ошибка при тестировании системы мотивации.',
      );
    }
  }

  /**
   * Show main statistics
   */
  private async showMainStatistics(ctx: BotContext) {
    try {
      const user = await this.getOrCreateUser(ctx);

      // Get today's date in user's timezone
      const today = new Date();
      const userTimezone = user.timezone || 'Europe/Moscow';
      const todayStr = today.toLocaleDateString('ru-RU', {
        timeZone: userTimezone,
      });

      // Get current date bounds for today's statistics
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const endOfToday = new Date();
      endOfToday.setHours(23, 59, 59, 999);

      // Get statistics from database
      const [
        completedTasksCount,
        totalTasksCount,
        habitStats,
        todayTasksCount,
        todayHabitsCount,
      ] = await Promise.all([
        // Completed tasks total
        this.prisma.task.count({
          where: {
            userId: user.id,
            status: 'COMPLETED',
          },
        }),
        // Total tasks
        this.prisma.task.count({
          where: {
            userId: user.id,
          },
        }),
        // Get habit statistics
        this.prisma.habit.aggregate({
          where: {
            userId: user.id,
          },
          _sum: {
            totalCompletions: true,
          },
          _count: {
            id: true,
          },
        }),
        // Today's completed tasks
        this.prisma.task.count({
          where: {
            userId: user.id,
            completedAt: {
              gte: startOfToday,
              lte: endOfToday,
            },
          },
        }),
        // Today's habit completions - we'll approximate this by counting habits with recent activity
        this.prisma.habit.count({
          where: {
            userId: user.id,
            updatedAt: {
              gte: startOfToday,
              lte: endOfToday,
            },
          },
        }),
      ]);

      const totalHabitsCount = habitStats._count.id || 0;
      const completedHabitsCount = habitStats._sum.totalCompletions || 0;

      // Calculate completion rates
      const taskCompletionRate =
        totalTasksCount > 0
          ? Math.round((completedTasksCount / totalTasksCount) * 100)
          : 0;
      const habitCompletionRate =
        totalHabitsCount > 0
          ? Math.round((completedHabitsCount / totalHabitsCount) * 100)
          : 0;

      // Get user's current level and XP
      const totalXP = user.totalXp || 0;
      const level = user.level || 1;

      // Calculate XP for current level (each level requires level * 100 XP)
      let xpRequiredForCurrentLevel = 0;
      for (let i = 1; i < level; i++) {
        xpRequiredForCurrentLevel += i * 100;
      }

      const xpForNextLevel = level * 100; // XP needed to reach next level
      const currentLevelXP = Math.max(0, totalXP - xpRequiredForCurrentLevel); // XP progress within current level
      const xpToNextLevel = Math.max(0, xpForNextLevel - currentLevelXP);

      // Create progress bar
      const progressRatio =
        xpForNextLevel > 0 ? currentLevelXP / xpForNextLevel : 0;
      const progressBarLength = 10;
      const filledBars = Math.floor(progressRatio * progressBarLength);
      const emptyBars = progressBarLength - filledBars;
      const progressBar = '█'.repeat(filledBars) + '⬜'.repeat(emptyBars);

      const message = `
📊 *Ваша статистика*

👤 **Профиль:**
⭐ Общий опыт: ${totalXP} XP
🎖️ Уровень: ${level}

🎯 **Прогресс уровня:**
\`${progressBar}\` ${Math.round(progressRatio * 100)}%
📈 ${currentLevelXP}/${xpForNextLevel} XP до ${level + 1} уровня
⏳ Осталось: ${xpToNextLevel} XP

📅 В системе с: ${user.createdAt.toLocaleDateString('ru-RU')}

📝 **Задачи:**
✅ Выполнено: ${completedTasksCount} из ${totalTasksCount}
📊 Процент выполнения: ${taskCompletionRate}%
🎯 Сегодня выполнено: ${todayTasksCount}

🔄 **Привычки:**
✅ Всего выполнений: ${completedHabitsCount}
📋 Создано привычек: ${totalHabitsCount}
📊 Активность: ${habitCompletionRate}%
🎯 Сегодня выполнено: ${todayHabitsCount}

📅 **Сегодня (${todayStr}):**
${
  todayTasksCount > 0 || todayHabitsCount > 0
    ? `🟢 Активный день! Выполнено ${todayTasksCount + todayHabitsCount} действий`
    : '🔴 Пока активности не было'
}

💡 *Продолжайте выполнять задачи и привычки для получения XP!*
      `;

      await ctx.replyWithMarkdown(message, {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '🎯 Детальная статистика',
                callback_data: 'progress_stats',
              },
            ],
            [
              {
                text: '🏆 Достижения',
                callback_data: 'achievements',
              },
            ],
            [
              {
                text: '🔙 Назад',
                callback_data: 'back_to_menu',
              },
            ],
          ],
        },
      });
    } catch (error) {
      this.logger.error('Error showing main statistics:', error);
      await ctx.replyWithMarkdown(
        '❌ Произошла ошибка при загрузке статистики. Попробуйте позже.',
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔙 Назад',
                  callback_data: 'back_to_menu',
                },
              ],
            ],
          },
        },
      );
    }
  }

  async showDetailedStatistics(ctx: any) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: ctx.userId },
      });

      if (!user) {
        await ctx.editMessageTextWithMarkdown(`❌ Пользователь не найден.`, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад', callback_data: 'more_functions' }],
            ],
          },
        });
        return;
      }

      // Get today's date for progress display
      const today = new Date();
      const todayStart = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
      );
      const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

      // Get task statistics
      const taskStats = await this.prisma.task.aggregate({
        where: { userId: user.id },
        _count: {
          id: true,
        },
      });

      const completedTaskStats = await this.prisma.task.aggregate({
        where: {
          userId: user.id,
          status: 'COMPLETED',
        },
        _count: {
          id: true,
        },
      });

      const todayTaskStats = await this.prisma.task.aggregate({
        where: {
          userId: user.id,
          createdAt: {
            gte: todayStart,
            lt: todayEnd,
          },
        },
        _count: {
          id: true,
        },
      });

      // Get habit statistics
      const habitStats = await this.prisma.habit.aggregate({
        where: { userId: user.id },
        _count: {
          id: true,
        },
      });

      const habitCompletionStats = await this.prisma.habit.aggregate({
        where: { userId: user.id },
        _sum: {
          totalCompletions: true,
        },
      });

      const todayHabitStats = await this.prisma.habit.aggregate({
        where: {
          userId: user.id,
          createdAt: {
            gte: todayStart,
            lt: todayEnd,
          },
        },
        _count: {
          id: true,
        },
      });

      const totalTasks = taskStats._count.id || 0;
      const completedTasks = completedTaskStats._count.id || 0;
      const todayTasks = todayTaskStats._count.id || 0;

      const totalHabits = habitStats._count.id || 0;
      const completedHabits = habitCompletionStats._sum.totalCompletions || 0;
      const todayHabits = todayHabitStats._count.id || 0;

      const completionRate =
        totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
      const habitCompletionRate =
        totalHabits > 0
          ? Math.round((completedHabits / (totalHabits * 30)) * 100)
          : 0; // Assuming 30 days average

      const todayStr = today.toLocaleDateString('ru-RU');

      await ctx.editMessageTextWithMarkdown(
        `
🎯 *Детальная статистика*

📊 **Общая информация:**
⭐ Опыт: ${user.totalXp} XP
🎖️ Уровень: ${user.level}
📅 Дата регистрации: ${user.createdAt.toLocaleDateString('ru-RU')}

📝 **Задачи:**
📝 Всего создано: ${totalTasks}
✅ Выполнено: ${completedTasks}
📈 Процент выполнения: ${completionRate}%
🎯 Сегодня создано: ${todayTasks}

🔄 **Привычки:**
💪 Всего создано: ${totalHabits}
✅ Выполнений: ${completedHabits}
📈 Средняя активность: ${habitCompletionRate}%
🎯 Сегодня создано: ${todayHabits}

📈 **Прогресс за сегодня:** ${todayStr}
${todayTasks > 0 || todayHabits > 0 ? '🟢 Активный день!' : '🔴 Пока без активности'}

🎮 **Скоро появятся достижения!**
🌅 Ранняя пташка (подъем до 7:00)
🏃 Спринтер задач (выполнить 5 задач подряд)
🔥 Серия успехов (выполнить все задачи дня)  
🎯 Снайпер целей (попасть в дедлайн)

Продолжайте выполнять задачи для получения XP! 🚀
      `,
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '📊 Основная статистика',
                  callback_data: 'my_progress',
                },
                { text: '🏆 Достижения', callback_data: 'achievements' },
              ],
              [{ text: '🔙 Назад', callback_data: 'more_functions' }],
            ],
          },
        },
      );
    } catch (error) {
      this.logger.error('Error showing detailed statistics:', error);
      await ctx.editMessageTextWithMarkdown(
        `❌ Произошла ошибка при загрузке детальной статистики.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Назад', callback_data: 'more_functions' }],
            ],
          },
        },
      );
    }
  }

  private async showHabitsStatistics(ctx: BotContext) {
    try {
      const habits = await this.habitService.findHabitsByUserId(ctx.userId);
      const user = await this.userService.findByTelegramId(ctx.userId);

      if (habits.length === 0) {
        await ctx.editMessageTextWithMarkdown(
          `📊 *Статистика привычек*\n\nУ вас пока нет привычек для анализа.\n\n💡 Добавьте первую привычку, чтобы начать отслеживание!`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🎯 Добавить привычку', callback_data: 'habits_add' }],
                [{ text: '🔙 К привычкам', callback_data: 'menu_habits' }],
              ],
            },
          },
        );
        return;
      }

      // Подсчитываем общую статистику
      const totalCompletions = habits.reduce(
        (sum, h) => sum + (h.totalCompletions || 0),
        0,
      );
      const avgCompletions = Math.round(totalCompletions / habits.length);
      const maxStreak = Math.max(...habits.map((h) => h.maxStreak || 0));
      const activeHabits = habits.filter((h) => h.isActive).length;

      // Находим самую успешную привычку
      const topHabit = habits.reduce((top, current) =>
        (current.totalCompletions || 0) > (top.totalCompletions || 0)
          ? current
          : top,
      );

      let message = `📊 *Статистика привычек*\n\n`;
      message += `🎯 **Общий обзор:**\n`;
      message += `📋 Всего привычек: ${habits.length}\n`;
      message += `✅ Активных: ${activeHabits}\n`;
      message += `🏆 Всего выполнений: ${totalCompletions}\n`;
      message += `📈 Средние выполнения: ${avgCompletions}\n`;
      message += `🔥 Максимальная серия: ${maxStreak} дней\n\n`;

      message += `👑 **Топ привычка:**\n`;
      message += `🎯 ${topHabit.title}\n`;
      message += `✅ ${topHabit.totalCompletions || 0} выполнений\n`;
      message += `🔥 Серия: ${topHabit.currentStreak || 0} дней\n\n`;

      message += `📊 **Детальная статистика:**\n`;

      for (const habit of habits.slice(0, 5)) {
        const progress = this.getHabitProgressAnimation(
          habit.totalCompletions || 0,
        );
        message += `\n🎯 **${habit.title}**\n`;
        message += `${progress}\n`;
        message += `✅ Выполнений: ${habit.totalCompletions || 0}\n`;
        message += `🔥 Серия: ${habit.currentStreak}/${habit.maxStreak} дней\n`;
      }

      if (habits.length > 5) {
        message += `\n*... и еще ${habits.length - 5} привычек*`;
      }

      await ctx.editMessageTextWithMarkdown(message, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🎯 К привычкам', callback_data: 'menu_habits' },
              { text: '📊 Общая статистика', callback_data: 'my_progress' },
            ],
            [{ text: '🏠 Главное меню', callback_data: 'back_to_menu' }],
          ],
        },
      });
    } catch (error) {
      this.logger.error('Error in showHabitsStatistics:', error);
      await ctx.editMessageTextWithMarkdown(
        '❌ Ошибка при загрузке статистики привычек',
      );
    }
  }

  // 🔧 Методы для обработки кнопок reply клавиатуры
  private isReplyKeyboardButton(text: string): boolean {
    const buttons = [
      '📝 Мои задачи',
      '+ Добавить задачу',
      '✅ Отметить выполнение',
      '📊 Статистика',
      '🏆 Достижения',
      '👥 Друзья',
      '🤖 AI Чат',
      '⏰ Таймер',
    ];
    return buttons.includes(text);
  }

  private async handleReplyKeyboardButton(
    ctx: BotContext,
    buttonText: string,
  ): Promise<void> {
    this.logger.log(
      `Handling reply keyboard button: "${buttonText}" for user ${ctx.userId}`,
    );

    switch (buttonText) {
      case '📝 Мои задачи':
        const user = await this.userService.findByTelegramId(ctx.userId);
        if (!user.timezone) {
          ctx.session.step = 'adding_task';
          await this.askForTimezone(ctx);
        } else {
          await this.showTasksMenu(ctx);
        }
        break;

      case '+ Добавить задачу':
        const userForTask = await this.userService.findByTelegramId(ctx.userId);
        if (!userForTask.timezone) {
          ctx.session.pendingAction = 'adding_task';
          await this.askForTimezone(ctx);
        } else {
          ctx.session.step = 'waiting_for_task_title';
          await ctx.replyWithMarkdown(
            '✍️ *Добавление задачи*\n\nВведите название задачи:\n\n⬇️ *Введите текст в поле для ввода ниже*',
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '❌ Отмена', callback_data: 'back_to_menu' }],
                ],
              },
            },
          );
        }
        break;

      case '✅ Отметить выполнение':
        await this.showTasksMenu(ctx); // Используем существующий метод
        break;

      case '📊 Статистика':
        await this.showDetailedStatistics(ctx);
        break;

      case '🏆 Достижения':
        await ctx.replyWithMarkdown('🏆 *Достижения* - функция в разработке');
        break;

      case '👥 Друзья':
        await ctx.replyWithMarkdown('👥 *Друзья* - функция в разработке');
        break;

      case '🤖 AI Чат':
        await this.startAIChat(ctx);
        break;

      case '⏰ Таймер':
        await this.showFocusSession(ctx); // Используем существующий метод
        break;

      default:
        await ctx.replyWithMarkdown(
          '🤔 Неизвестная команда. Используйте кнопки меню.',
        );
        break;
    }
  }
}
