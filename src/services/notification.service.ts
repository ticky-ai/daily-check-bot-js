import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import { Cron, CronExpression, SchedulerRegistry } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';
import { morningNotificationAiPrompt, eveningNotificationAiPrompt } from "../prompts/notification.prompts"
import { TelegramBotService } from '../bot/telegram-bot.service';
import { HabitService } from './habit.service';
import { OpenAIService } from './openai.service';
import { TaskService } from './task.service';
import * as cron from 'node-cron';

interface HabitReminder {
  habitId: string;
  userId: string;
  habitTitle: string;
  cronPattern: string;
  lastSent?: Date;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private activeReminders: Map<string, cron.ScheduledTask> = new Map();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => TelegramBotService))
    private readonly telegramBotService: TelegramBotService,
    private readonly habitService: HabitService,
    private readonly openaiService: OpenAIService,
    private readonly taskService: TaskService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onModuleInit() {
    this.logger.log('Notification service initialized');
    // Загружаем активные напоминания при запуске
    await this.loadActiveHabitReminders();
  }

  async loadActiveHabitReminders() {
    // Individual habit reminders are disabled - using only morning and evening AI notifications
    // const activeHabits = await this.prisma.habit.findMany({
    //   where: {
    //     isActive: true,
    //     reminderTime: { not: null },
    //   },
    //   include: {
    //     user: true,
    //   },
    // });

    // for (const habit of activeHabits) {
    //   await this.scheduleHabitReminder(habit);
    // }

    this.logger.log(
      'Individual habit reminders disabled - using AI notifications only',
    );
  }

  async scheduleHabitReminder(habit: any) {
    const cronPattern = this.parseReminderPattern(
      habit.reminderTime,
      habit.frequency,
    );

    if (!cronPattern) {
      this.logger.warn(
        `Could not parse reminder pattern for habit ${habit.id}`,
      );
      return;
    }

    const jobName = `habit_reminder_${habit.id}`;

    // Удаляем существующее напоминание, если есть
    if (this.activeReminders.has(jobName)) {
      this.cancelHabitReminder(habit.id);
    }

    try {
      const task = cron.schedule(cronPattern, async () => {
        await this.sendHabitReminder(habit);
      });

      this.activeReminders.set(jobName, task);
      task.start();

      this.logger.log(
        `Scheduled reminder for habit "${habit.title}" with pattern: ${cronPattern}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to schedule reminder for habit ${habit.id}:`,
        error,
      );
    }
  }

  private parseReminderPattern(
    reminderTime: string,
    frequency: string,
  ): string | null {
    // Парсим различные форматы времени
    if (
      reminderTime.includes('каждый час') ||
      reminderTime.includes('hourly')
    ) {
      return '0 * * * *'; // Каждый час в начале часа
    }

    if (
      reminderTime.includes('каждые 2 часа') ||
      reminderTime.includes('every 2 hours')
    ) {
      return '0 */2 * * *'; // Каждые 2 часа
    }

    if (
      reminderTime.includes('каждые 3 часа') ||
      reminderTime.includes('every 3 hours')
    ) {
      return '0 */3 * * *'; // Каждые 3 часа
    }

    if (
      reminderTime.includes('каждые 4 часа') ||
      reminderTime.includes('every 4 hours')
    ) {
      return '0 */4 * * *'; // Каждые 4 часа
    }

    if (
      reminderTime.includes('каждые 6 часов') ||
      reminderTime.includes('every 6 hours')
    ) {
      return '0 */6 * * *'; // Каждые 6 часов
    }

    // Парсим конкретное время (например, "09:00", "14:30")
    const timeMatch = reminderTime.match(/(\d{1,2}):(\d{2})/);
    if (timeMatch) {
      const [, hours, minutes] = timeMatch;
      if (frequency === 'DAILY') {
        return `${minutes} ${hours} * * *`; // Каждый день в указанное время
      }
      if (frequency === 'WEEKLY') {
        return `${minutes} ${hours} * * 1`; // Каждый понедельник в указанное время
      }
    }

    // Парсим интервалы в минутах
    if (
      reminderTime.includes('каждую минуту') ||
      reminderTime.includes('every minute')
    ) {
      return '* * * * *'; // Каждую минуту
    }

    if (
      reminderTime.includes('каждые две минуты') ||
      reminderTime.includes('каждые 2 минуты') ||
      reminderTime.includes('every 2 minutes')
    ) {
      return '*/2 * * * *'; // Каждые 2 минуты
    }

    if (
      reminderTime.includes('каждые три минуты') ||
      reminderTime.includes('каждые 3 минуты') ||
      reminderTime.includes('every 3 minutes')
    ) {
      return '*/3 * * * *'; // Каждые 3 минуты
    }

    if (
      reminderTime.includes('каждые пять минут') ||
      reminderTime.includes('каждые 5 минут') ||
      reminderTime.includes('every 5 minutes')
    ) {
      return '*/5 * * * *'; // Каждые 5 минут
    }

    if (
      reminderTime.includes('каждые десять минут') ||
      reminderTime.includes('каждые 10 минут') ||
      reminderTime.includes('every 10 minutes')
    ) {
      return '*/10 * * * *'; // Каждые 10 минут
    }

    if (
      reminderTime.includes('каждые 15 минут') ||
      reminderTime.includes('every 15 minutes')
    ) {
      return '*/15 * * * *'; // Каждые 15 минут
    }

    if (
      reminderTime.includes('каждые 30 минут') ||
      reminderTime.includes('каждые полчаса') ||
      reminderTime.includes('every 30 minutes')
    ) {
      return '*/30 * * * *'; // Каждые 30 минут
    }

    // Дефолтное поведение для ежедневных привычек - 9 утра
    if (frequency === 'DAILY') {
      return '0 9 * * *';
    }

    return null;
  }

  async sendHabitReminder(habit: any) {
    try {
      const user =
        habit.user ||
        (await this.prisma.user.findUnique({
          where: { id: habit.userId },
        }));

      if (!user) {
        this.logger.warn(`User not found for habit ${habit.id}`);
        return;
      }

      // Проверяем настройки уведомлений пользователя
      if (!user.dailyReminders) {
        this.logger.log(
          `User ${user.id} has disabled reminders, skipping habit reminder`,
        );
        return;
      }

      // Проверка пропуска привычки на сегодня
      if (
        await this.telegramBotService.isHabitSkippedToday(habit.id, user.id)
      ) {
        this.logger.log(
          `Habit ${habit.id} is skipped for today, not sending reminder`,
        );
        return;
      }

      // Проверяем, не отправляли ли уже напоминание в последние 30 минут
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      if (habit.updatedAt && habit.updatedAt > thirtyMinutesAgo) {
        this.logger.log(
          `Habit reminder for ${habit.id} was already sent recently, skipping`,
        );
        return;
      }

      const message = this.generateReminderMessage(habit);
      const keyboard = this.generateReminderKeyboard(habit.id);

      await this.telegramBotService.sendMessageToUser(
        parseInt(user.id),
        message,
        {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        },
      );

      // Обновляем время последней отправки
      await this.prisma.habit.update({
        where: { id: habit.id },
        data: { updatedAt: new Date() },
      });

      this.logger.log(
        `Sent reminder for habit "${habit.title}" to user ${user.id}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to send reminder for habit ${habit.id}:`,
        error,
      );
    }
  }

  private generateReminderMessage(habit: any): string {
    const messages = {
      'пить воду каждый час': [
        '💧 Время пить воду! Не забывайте о гидратации!',
        '🚰 Пора выпить стакан воды! Ваш организм скажет спасибо!',
        '💦 Напоминание: время для воды! Поддерживайте водный баланс!',
      ],
      'делать зарядку': [
        '🏃‍♂️ Время для зарядки! Разомните тело!',
        '💪 Пора делать упражнения! Ваше тело ждет движения!',
        '🤸‍♀️ Время зарядки! Несколько упражнений придадут бодрости!',
      ],
      медитация: [
        '🧘‍♂️ Время для медитации. Найдите несколько минут для себя!',
        '🌸 Пора помедитировать! Успокойте ум и расслабьтесь!',
        '☯️ Время внутренней гармонии! Несколько минут медитации!',
      ],
    };

    // Ищем подходящее сообщение по ключевым словам
    const habitTitle = habit.title.toLowerCase();

    for (const [key, messageList] of Object.entries(messages)) {
      if (habitTitle.includes(key)) {
        return messageList[Math.floor(Math.random() * messageList.length)];
      }
    }

    // Дефолтное сообщение
    return `⏰ *Напоминание о привычке*\n\n🎯 ${habit.title}\n\nВремя выполнить вашу привычку!`;
  }

  private generateReminderKeyboard(habitId: string) {
    return {
      inline_keyboard: [
        [
          { text: '✅ Выполнил', callback_data: `complete_habit_${habitId}` },
          {
            text: '⏰ Отложить на 15 мин',
            callback_data: `snooze_habit_${habitId}_15`,
          },
        ],
        [
          { text: '📊 Статистика', callback_data: `habit_stats_${habitId}` },
          {
            text: '❌ Пропустить сегодня',
            callback_data: `skip_habit_${habitId}`,
          },
        ],
        [
          {
            text: '🔕 Отключить уведомления',
            callback_data: 'disable_all_reminders',
          },
        ],
      ],
    };
  }

  async cancelHabitReminder(habitId: string) {
    const jobName = `habit_reminder_${habitId}`;

    if (this.activeReminders.has(jobName)) {
      const task = this.activeReminders.get(jobName);
      task?.stop();
      task?.destroy();
      this.activeReminders.delete(jobName);

      this.logger.log(`Cancelled reminder for habit ${habitId}`);
    }
  }

  async updateHabitReminder(habitId: string) {
    // Individual habit reminders are disabled - using only morning and evening AI notifications
    this.logger.log(
      `Individual habit reminder update skipped for habit ${habitId} - using AI notifications only`,
    );

    // const habit = await this.prisma.habit.findUnique({
    //   where: { id: habitId },
    //   include: { user: true },
    // });

    // if (!habit) {
    //   return;
    // }

    // // Отменяем старое напоминание
    // await this.cancelHabitReminder(habitId);

    // // Создаем новое, если привычка активна и есть время напоминания
    // if (habit.isActive && habit.reminderTime) {
    //   await this.scheduleHabitReminder(habit);
    // }
  }

  // Метод для обработки snooze (отложить напоминание)
  async snoozeHabitReminder(habitId: string, minutes: number) {
    const delayMs = minutes * 60 * 1000;

    setTimeout(async () => {
      const habit = await this.prisma.habit.findUnique({
        where: { id: habitId },
        include: { user: true },
      });

      if (habit) {
        await this.sendHabitReminder(habit);
      }
    }, delayMs);

    this.logger.log(`Snoozed habit ${habitId} for ${minutes} minutes`);
  }

  // Cron job для проверки и отправки напоминаний каждую минуту - ОТКЛЮЧЕН
  // Теперь уведомления только для пользователей с активной зависимостью
  // @Cron(CronExpression.EVERY_MINUTE)
  async checkAndSendReminders() {
    // DISABLED: This was sending notifications to ALL users
    // Now only dependency support users get morning/evening messages
    return;

    try {
      const now = new Date();
      // Ищем напоминания, которые должны быть отправлены в текущую минуту
      const currentMinuteStart = new Date(now);
      currentMinuteStart.setSeconds(0, 0);
      const currentMinuteEnd = new Date(currentMinuteStart);
      currentMinuteEnd.setMinutes(currentMinuteEnd.getMinutes() + 1);

      // Находим напоминания, которые должны быть отправлены сейчас
      const remindersToSend = await this.prisma.reminder.findMany({
        where: {
          status: 'ACTIVE',
          scheduledTime: {
            gte: currentMinuteStart,
            lt: currentMinuteEnd,
          },
        },
        include: {
          user: true,
        },
      });

      for (const reminder of remindersToSend) {
        try {
          // Проверяем настройки пользователя на уведомления
          if (!reminder.user.dailyReminders) {
            this.logger.log(
              `User ${reminder.userId} has disabled reminders, skipping`,
            );
            // Помечаем как пропущенное
            await this.prisma.reminder.update({
              where: { id: reminder.id },
              data: { status: 'DISMISSED' },
            });
            continue;
          }

          await this.sendGeneralReminder(reminder);

          // Обновляем статус напоминания
          await this.prisma.reminder.update({
            where: { id: reminder.id },
            data: {
              status: 'COMPLETED',
            },
          });

          this.logger.log(
            `Sent reminder "${reminder.title}" to user ${reminder.userId}`,
          );
        } catch (error) {
          this.logger.error(`Failed to send reminder ${reminder.id}:`, error);

          // Помечаем как отклоненное
          await this.prisma.reminder.update({
            where: { id: reminder.id },
            data: { status: 'DISMISSED' },
          });
        }
      }

      if (remindersToSend.length > 0) {
        this.logger.log(`Processed ${remindersToSend.length} reminders`);
      }
    } catch (error) {
      this.logger.error('Error in checkAndSendReminders:', error);
    }
  }

  private async sendGeneralReminder(reminder: any) {
    const message = `🔔 *Напоминание!*\n\n${reminder.message}`;

    await this.telegramBotService.sendMessageToUser(
      parseInt(reminder.user.id),
      message,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Готово',
                callback_data: `reminder_done_${reminder.id.substring(0, 20)}`,
              },
            ],
            [
              {
                text: '⏰ Через 15 мин',
                callback_data: `reminder_snooze_15_${reminder.id.substring(0, 20)}`,
              },
              {
                text: '⏰ Через час',
                callback_data: `reminder_snooze_60_${reminder.id.substring(0, 20)}`,
              },
            ],
            [
              {
                text: '🔕 Отключить уведомления',
                callback_data: 'disable_all_reminders',
              },
            ],
          ],
        },
      },
    );
  }

  // Cron job для очистки старых напоминаний (раз в день)
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldJobs() {
    this.logger.log('Running daily cleanup of notification jobs');

    // Здесь можно добавить логику очистки неактивных привычек
    const inactiveHabits = await this.prisma.habit.findMany({
      where: { isActive: false },
      select: { id: true },
    });

    for (const habit of inactiveHabits) {
      await this.cancelHabitReminder(habit.id);
    }

    this.logger.log(
      `Cleaned up ${inactiveHabits.length} inactive habit reminders`,
    );
  }

  // === DEPENDENCY SUPPORT SYSTEM ===

  // Cron job для утренних мотивационных сообщений (каждый день в 9:00)
  @Cron('0 9 * * *')
  async sendMorningMotivation() {
    this.logger.log('Running morning motivation messages');

    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0); // Start of today

      const activeDependencies = await this.prisma.dependencySupport.findMany({
        where: {
          status: 'ACTIVE',
          // Only send if we haven't sent a morning message today
          OR: [{ lastMorningSent: null }, { lastMorningSent: { lt: today } }],
        },
        include: { user: true },
      });

      for (const dependency of activeDependencies) {
        try {
          const motivation = this.generateMorningMotivation(dependency.type);

          await this.telegramBotService.sendMessageToUser(
            parseInt(dependency.user.id),
            `🌅 *Доброе утро!*\n\n${motivation}\n\n💪 Ты сможешь справиться с этим!`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '🤝 Обещаю сам себе',
                      callback_data: `morning_promise_${dependency.type.toLowerCase()}`,
                    },
                  ],
                ],
              },
              parse_mode: 'Markdown',
            },
          );

          // Обновляем статистику и отмечаем время отправки
          await this.prisma.dependencySupport.update({
            where: { id: dependency.id },
            data: {
              totalPromises: dependency.totalPromises + 1,
              lastMorningSent: new Date(), // Mark when we sent morning message
            },
          });
        } catch (error) {
          this.logger.error(
            `Failed to send morning message to ${dependency.user.id}:`,
            error,
          );
        }
      }

      this.logger.log(
        `Sent morning messages to ${activeDependencies.length} users`,
      );
    } catch (error) {
      this.logger.error('Error in morning motivation job:', error);
    }
  }

  // Cron job для вечерних проверок (каждый день в 21:00)
  @Cron('0 21 * * *')
  async sendEveningCheck() {
    this.logger.log('Running evening check messages');

    try {
      const activeDependencies = await this.prisma.dependencySupport.findMany({
        where: { status: 'ACTIVE' },
        include: { user: true },
      });

      for (const dependency of activeDependencies) {
        try {
          const checkMessage = this.generateEveningCheck(dependency.type);

          await this.telegramBotService.sendMessageToUser(
            parseInt(dependency.user.id),
            `🌙 *Время подвести итоги дня*\n\n${checkMessage}\n\n❓ Как прошел день? Продержался?`,
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    {
                      text: '💪 Держусь',
                      callback_data: `evening_holding_${dependency.type.toLowerCase()}`,
                    },
                    {
                      text: '😔 Сдался',
                      callback_data: `evening_failed_${dependency.type.toLowerCase()}`,
                    },
                  ],
                ],
              },
              parse_mode: 'Markdown',
            },
          );
        } catch (error) {
          this.logger.error(
            `Failed to send evening message to ${dependency.user.id}:`,
            error,
          );
        }
      }

      this.logger.log(
        `Sent evening messages to ${activeDependencies.length} users`,
      );
    } catch (error) {
      this.logger.error('Error in evening check job:', error);
    }
  }

  private generateMorningMotivation(dependencyType: string): string {
    const motivations = {
      SMOKING: [
        '🚭 Каждый день без сигарет - это день, когда ты становишься сильнее',
        '🌱 Твоё тело уже начинает восстанавливаться. Продолжай!',
        '💨 Каждый вдох чистого воздуха - это твоя победа',
      ],
      ALCOHOL: [
        '🧠 Ясность мысли и энергия - это твои награды за трезвость',
        '💪 Ты контролируешь свою жизнь, а не зависимость',
        '🌟 Каждый трезвый день приближает тебя к лучшей версии себя',
      ],
      DRUGS: [
        '🆓 Свобода от веществ - это свобода быть собой',
        '🧘‍♂️ Твой разум становится яснее с каждым днем',
        '🌈 Жизнь полна красок, когда ты видишь её реальной',
      ],
      GAMING: [
        '🎯 Реальная жизнь - это твоя главная игра',
        '⏰ Время, потраченное на развитие, никогда не теряется',
        '🌱 Каждый день без игр - шаг к новым достижениям',
      ],
      SOCIAL_MEDIA: [
        '📱 Реальный мир намного интереснее виртуального',
        '👥 Живое общение дает энергию, которую не даст экран',
        '🧘‍♀️ Покой ума приходит с отключением от постоянного потока информации',
      ],
    };

    const typeMotivations = motivations[dependencyType] || motivations.SMOKING;
    return typeMotivations[Math.floor(Math.random() * typeMotivations.length)];
  }

  private generateEveningCheck(dependencyType: string): string {
    const checks = {
      SMOKING: '🚭 Как дела с отказом от курения?',
      ALCOHOL: '🍷 Как прошел день без алкоголя?',
      DRUGS: '💊 Удалось ли избежать употребления?',
      GAMING: '🎮 Контролировал ли время за играми?',
      SOCIAL_MEDIA: '📱 Как дела с ограничением соцсетей?',
    };

    return checks[dependencyType] || checks.SMOKING;
  }

  // New AI-powered morning and evening notifications for all users
  // @Cron('0 9 * * *')
  @Cron('*/30 * * * *', { name: 'morningAINotifications' })
  async sendMorningAINotifications() {
    this.logger.log('Running morning AI notifications for all users');

    try {
      // Get all users with timezone and active tasks/habits
      const users = await this.prisma.user.findMany({
        where: {
          timezone: { not: null },
          id: '53527242',
          OR: [
            { habits: { some: { isActive: true } } },
            { tasks: { some: { status: 'PENDING' } } },
          ],
        },
        include: {
          habits: { where: { isActive: true } },
          tasks: { where: { status: 'PENDING' } },
        },
      });

      for (const user of users) {
        try {
          // Check timesone 
              const userTimezone = user.timezone;
              if (!userTimezone) {
                this.logger.log(`Skipping user ${user.id}, no timezone set`);
                continue;
              }
              const nowInUserTz = new Date().toLocaleString("en-US", { timeZone: userTimezone });
              const userDate = new Date(nowInUserTz);
              const currentHour = userDate.getHours();
              const currentMinute = userDate.getMinutes();
            if (currentHour === 9 && currentMinute < 10) {
              // Generate AI advice based on user's tasks and habits
              const tasksText = user.tasks.map((t) => t.title).join(', ');
              const habitsText = user.habits.map((h) => `Привычка ${h.title} - текущий стрик по привычке ${h.currentStreak}`).join(', ');
        
              const aiPrompt = morningNotificationAiPrompt({
                tasksText: tasksText,
                habitsText: habitsText,
                firstname: user.firstName
              });

              const aiAdvice = await this.openaiService.getAIResponse(aiPrompt);

              await this.telegramBotService.sendMessageToUser(
                parseInt(user.id),
                `${aiAdvice}\n\n💪 Удачного дня!`, 
                {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: '🎯 Мои привычки', callback_data: 'my_habits' }],
                      [{ text: '📝 Мои задачи', callback_data: 'my_tasks' }],
                    ],
                  },
                  parse_mode: 'Markdown',
                },
              );

              this.logger.log(`Sent morning AI notification to user ${user.id}`);
            } else {
              this.logger.log(`Skipping user ${user.id}, their local time is ${nowInUserTz}`);
            };
        } catch (error) {
          this.logger.error(
            `Failed to send morning AI notification to ${user.id}:`,
            error,
          );
        }
      }

      this.logger.log(`Sent morning AI notifications to ${users.length} users`);
    } catch (error) {
      this.logger.error('Error in morning AI notifications job:', error);
    }
  }

  @Cron('*/5 * * * *',  { name: 'eveningAINotifications' })
  async sendEveningAISummary() {
    this.logger.log('Running evening AI summary for all users');

    try {
      // Get all users with completed tasks and habit data
      const users = await this.prisma.user.findMany({
        where: {
          timezone: { not: null },
          id: '53527242',
          OR: [
            { habits: { some: { isActive: true } } },
            { tasks: { some: {} } },
          ],
        },
        include: {
          habits: { where: { isActive: true } },
          tasks: true
        },
      });

      for (const user of users) {
        try {
          const userTimezone = user.timezone;
              if (!userTimezone) {
                this.logger.log(`Skipping user ${user.id}, no timezone set`);
                continue;
              }
              const nowInUserTz = new Date().toLocaleString("en-US", { timeZone: userTimezone });
              const userDate = new Date(nowInUserTz);
              const currentHour = userDate.getHours();
              const currentMinute = userDate.getMinutes();
            if (currentHour === 21 && currentMinute < 10) {
                const allTasksText = user.tasks.map((t) => t.title).join(', ');
                const completedTask = user.tasks.filter((task) => task.status === 'COMPLETED')
                const completedTasksText = completedTask.map((t) => t.title).join(', ');
                const userTaskProgress = (completedTasksText.length / allTasksText.length) * 100
                const allHabitsText = user.habits.map((h) => h.title).join(', ');
                const completedHabbits = user.habits.filter((habit) => this.habitService.isCompletedTodayTZ(habit, nowInUserTz))
                const userHabbitsProgress = (completedHabbits.length / user.habits.length) * 100
                const completedHabbitsText = completedHabbits.map((h) => `Привычка ${h.title} - текущий стрик по привычке ${h.currentStreak}`).join(', ');
                const aiPrompt = eveningNotificationAiPrompt({
                allTasksText: allTasksText,
                completedTask: completedTask,
                completedTasksText: completedTasksText,
                userTaskProgress: userTaskProgress,
                allHabitsText: allHabitsText,
                completedHabbits: completedHabbits,
                userHabbitsProgress: userHabbitsProgress, 
                completedHabbitsText: completedHabbitsText,
                firstname: user.firstName
              });

          const aiAnalysis = await this.openaiService.getAIResponse(aiPrompt);

          await this.telegramBotService.sendMessageToUser(
            parseInt(user.id),
            `${aiAnalysis}\n\n😴 Спокойной ночи!`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '📊 Мой прогресс', callback_data: 'my_progress' }],
                  [
                    {
                      text: '🎯 Завтра начнем сначала!',
                      callback_data: 'back_to_menu',
                    },
                  ],
                ],
              },
              parse_mode: 'Markdown',
            },
          );

          this.logger.log(`Sent evening AI summary to user ${user.id}`);
          } else {
              this.logger.log(`Skipping user ${user.id}, their local time is ${nowInUserTz}`);
            };
        } catch (error) {
          this.logger.error(
            `Failed to send evening AI summary to ${user.id}:`,
            error,
          );
        }
      }

      this.logger.log(`Sent evening AI summaries to ${users.length} users`);
    } catch (error) {
      this.logger.error('Error in evening AI summary job:', error);
    }
  }
}
