import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { OpenAIService } from './openai.service';

export interface UserContext {
  userId: string;
  name?: string;
  timezone?: string;
  preferences?: any;
  goals?: string[];
  habits?: Array<{
    name: string;
    category: string;
    streak: number;
    lastCompleted?: Date;
  }>;
  tasks?: Array<{
    title: string;
    priority: string;
    category: string;
    completed: boolean;
    dueDate?: Date;
  }>;
  moodHistory?: Array<{
    mood: string;
    date: Date;
    notes?: string;
  }>;
  focusSessions?: Array<{
    duration: number;
    date: Date;
    productivity: number;
  }>;
  dependencies?: string[];
  achievements?: string[];
  totalXp?: number;
  currentStreak?: number;
  subscriptionType?: string;
}

@Injectable()
export class AiContextService {
  constructor(
    private prisma: PrismaService,
    private openaiService: OpenAIService,
  ) {}

  async getUserContext(userId: string): Promise<UserContext> {
    try {
      // Получаем базовую информацию о пользователе
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          tasks: {
            take: 10,
            orderBy: { createdAt: 'desc' },
          },
          habits: {
            take: 10,
            orderBy: { createdAt: 'desc' },
          },
          moods: {
            take: 7,
            orderBy: { createdAt: 'desc' },
          },
          focusSessions: {
            take: 10,
            orderBy: { createdAt: 'desc' },
          },
          userAchievements: {
            include: {
              achievement: true,
            },
          },
        },
      });

      if (!user) {
        return { userId };
      }

      // Формируем контекст
      const context: UserContext = {
        userId,
        name: user.firstName || user.username || 'Пользователь',
        timezone: user.timezone || undefined,
        totalXp: user.totalXp || 0,
        currentStreak: user.currentStreak || 0,
        subscriptionType: user.subscriptionType || 'FREE',
        tasks:
          user.tasks?.map((task) => ({
            title: task.title,
            priority: task.priority.toString(),
            category: task.category || 'general',
            completed: task.status === 'COMPLETED',
            dueDate: task.dueDate || undefined,
          })) || [],
        moodHistory:
          user.moods?.map((mood) => ({
            mood: mood.mood.toString(),
            date: mood.createdAt,
            notes: mood.note || undefined,
          })) || [],
        habits:
          user.habits?.map((habit) => ({
            name: habit.title,
            category: habit.category || 'general',
            streak: habit.currentStreak || 0,
            lastCompleted: habit.updatedAt, // Используем updatedAt как приблизительную дату последнего выполнения
          })) || [],
        focusSessions:
          user.focusSessions?.map((session) => ({
            duration: session.actualDuration || session.plannedDuration || 0,
            date: session.createdAt,
            productivity: session.productivityRating || 5,
          })) || [],
        achievements:
          user.userAchievements?.map((ua) => ua.achievement.name) || [],
      };

      return context;
    } catch (error) {
      console.error('Error getting user context:', error);
      return { userId };
    }
  }

  async generatePersonalizedMessage(
    userId: string,
    messageType:
      | 'motivation'
      | 'task_suggestion'
      | 'habit_advice'
      | 'mood_analysis'
      | 'focus_tips'
      | 'dependency_help',
    customPrompt?: string,
  ): Promise<string> {
    const context = await this.getUserContext(userId);

    const systemPrompts = {
      motivation: this.getMotivationPrompt(context),
      task_suggestion: this.getTaskSuggestionPrompt(context),
      habit_advice: this.getHabitAdvicePrompt(context),
      mood_analysis: this.getMoodAnalysisPrompt(context),
      focus_tips: this.getFocusTipsPrompt(context),
      dependency_help: this.getDependencyHelpPrompt(context),
    };

    const systemPrompt = systemPrompts[messageType] || systemPrompts.motivation;
    const userPrompt = customPrompt || this.getDefaultUserPrompt(messageType);

    try {
      const fullPrompt = `${systemPrompt}\n\nПользователь: ${userPrompt}`;
      console.log(`🤖 Отправляем запрос к OpenAI для ${messageType}:`, {
        userId,
        messageType,
        habitsCount: context.habits?.length || 0,
        habits: context.habits?.map((h) => h.name).join(', ') || 'нет привычек',
        tasksCount: context.tasks?.length || 0,
        systemPromptLength: systemPrompt.length,
        userPromptLength: userPrompt.length,
      });
      const response = await this.openaiService.getAIResponse(fullPrompt);
      console.log(
        `✅ Получен ответ от OpenAI для ${messageType}:`,
        response?.substring(0, 200) + (response?.length > 200 ? '...' : ''),
      );

      return response;
    } catch (error) {
      console.error('❌ Ошибка при генерации ИИ ответа:', error);
      console.log('📋 Используем fallback сообщение');
      return this.getFallbackMessage(messageType, context);
    }
  }

  private getMotivationPrompt(context: UserContext): string {
    return `Ты персональный ИИ-помощник по продуктивности. 
    
Информация о пользователе:
- Имя: ${context.name}
- Опыт: ${context.totalXp} XP
- Текущий стрик: ${context.currentStreak} дней
- Подписка: ${context.subscriptionType}
- Активных задач: ${context.tasks?.filter((t) => !t.completed).length || 0}
- Завершенных задач: ${context.tasks?.filter((t) => t.completed).length || 0}
- Последнее настроение: ${context.moodHistory?.[0]?.mood || 'не указано'}

Твоя роль - мотивировать, поддерживать и давать персонализированные советы. 
Отвечай дружелюбно, с эмодзи, кратко (до 200 слов).
Учитывай прогресс пользователя и подбадривай его.`;
  }

  private getTaskSuggestionPrompt(context: UserContext): string {
    return `Ты ИИ-помощник по управлению задачами.
    
Контекст пользователя:
- Активные задачи: ${JSON.stringify(context.tasks?.filter((t) => !t.completed) || [])}
- Завершенные задачи: ${JSON.stringify(context.tasks?.filter((t) => t.completed) || [])}
- Настроение: ${context.moodHistory?.[0]?.mood || 'не указано'}
- Стрик: ${context.currentStreak} дней

Анализируй загруженность, приоритеты и предлагай:
1. Оптимизацию задач
2. Планирование времени
3. Разбивку сложных задач
4. Мотивационные советы

Отвечай конкретно и действенно, с эмодзи.`;
  }

  private getHabitAdvicePrompt(context: UserContext): string {
    const habits = context.habits || [];
    const activeHabits = habits.filter((h) => h.streak > 0);
    const strugglingHabits = habits.filter((h) => h.streak === 0);
    const avgStreak =
      habits.length > 0
        ? Math.round(
            habits.reduce((acc, h) => acc + h.streak, 0) / habits.length,
          )
        : 0;

    // Детальная информация о каждой привычке
    const habitDetails = habits
      .map((h) => {
        const daysSinceLastCompleted = h.lastCompleted
          ? Math.floor(
              (Date.now() - new Date(h.lastCompleted).getTime()) /
                (1000 * 60 * 60 * 24),
            )
          : 'никогда';
        return `"${h.name}" (категория: ${h.category}, стрик: ${h.streak} дней, последний раз: ${daysSinceLastCompleted === 'никогда' ? 'никогда' : daysSinceLastCompleted + ' дней назад'})`;
      })
      .join('; ');

    return `Ты персональный ИИ-коуч по формированию привычек. Твоя задача - дать КОНКРЕТНЫЕ и ПЕРСОНАЛЬНЫЕ советы для каждой привычки пользователя.

Профиль пользователя:
- Всего привычек: ${habits.length}
- Активных привычек (со стриком > 0): ${activeHabits.length}
- Проблемных привычек (стрик = 0): ${strugglingHabits.length}
- Средний стрик: ${avgStreak} дней
- Детали по привычкам: ${habitDetails || 'нет привычек'}
- Настроение: ${context.moodHistory?.[0]?.mood || 'не указано'}
- Общий опыт: ${context.totalXp} XP

ВАЖНО: 
1. В первой строке дай ОДНО мотивационное сообщение (до 150 символов)
2. Далее дай 3 КОНКРЕТНЫХ совета для КОНКРЕТНЫХ привычек пользователя:
   - Для привычек с хорошим стриком: как поддерживать мотивацию
   - Для проблемных привычек: конкретные техники для возобновления
   - Для новых привычек: как правильно начать

Примеры хороших советов:
- "Для привычки 'Бросить курить': когда возникает желание закурить, сделай 10 глубоких вдохов или выпей стакан воды"
- "Для 'Зарядка по утрам': поставь одежду для зарядки рядом с кроватью с вечера"
- "Для 'Чтение книг': читай хотя бы 1 страницу перед сном - это поможет восстановить привычку"

НЕ давай общие советы типа "верь в себя" - только конкретные действенные рекомендации для привычек пользователя!`;
  }

  private getMoodAnalysisPrompt(context: UserContext): string {
    const recentMoods = context.moodHistory?.slice(0, 5) || [];
    return `Ты ИИ-психолог и аналитик настроения.
    
Последние настроения пользователя: ${JSON.stringify(recentMoods)}
Задачи: ${context.tasks?.length || 0} (завершено: ${context.tasks?.filter((t) => t.completed).length || 0})
Стрик: ${context.currentStreak} дней

Анализируй:
- Паттерны настроения
- Связь с продуктивностью
- Рекомендации для улучшения
- Техники управления эмоциями

Будь эмпатичным, профессиональным, с практическими советами.`;
  }

  private getFocusTipsPrompt(context: UserContext): string {
    return `Ты ИИ-эксперт по концентрации и фокусу.
    
Пользователь:
- Активных задач: ${context.tasks?.filter((t) => !t.completed).length || 0}
- Настроение: ${context.moodHistory?.[0]?.mood || 'не указано'}
- Подписка: ${context.subscriptionType}

Предлагай:
- Техники концентрации
- Планирование фокус-сессий
- Борьбу с отвлечениями
- Персональные стратегии

Используй методы Помодоро, Deep Work, и другие научно обоснованные подходы.`;
  }

  private getDependencyHelpPrompt(context: UserContext): string {
    const completedTasks = context.tasks?.filter((t) => t.completed).length || 0;
    const totalTasks = context.tasks?.length || 0;
    const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    
    return `Ты опытный ИИ-консультант и психолог по избавлению от зависимостей (курение, алкоголь, игровая зависимость и др.). Твоя задача - дать КОНКРЕТНЫЕ, ДЕЙСТВЕННЫЕ советы, основанные на научных методах.

Профиль пользователя:
- Имя: ${context.name || 'Пользователь'}
- Опыт: ${context.totalXp || 0} XP
- Стрик достижений: ${context.currentStreak || 0} дней
- Продуктивность: ${completedTasks}/${totalTasks} задач (${completionRate}%)
- Настроение: ${context.moodHistory?.[0]?.mood || 'не указано'}
- Привычки: ${context.habits?.map((h) => h.name).join(', ') || 'нет'}

ВАЖНО: 
1. Дай КОНКРЕТНЫЕ техники и стратегии, а не общие слова поддержки
2. Учитывай контекст пользователя (его продуктивность, настроение, опыт)
3. Предложи план действий на ближайшие дни
4. Будь поддерживающим, но реалистичным
5. Используй научно обоснованные методы (когнитивно-поведенческая терапия, техники замещения, управление триггерами)

Примеры хороших советов:
- "Когда возникает желание закурить, используй технику 4-7-8: вдох на 4 счета, задержка на 7, выдох на 8. Повтори 3-4 раза."
- "Определи свои триггеры: стресс, скука, компания? Для каждого триггера подготовь альтернативу."
- "Веди дневник: записывай каждый раз, когда хочется вернуться к зависимости. Это поможет понять паттерны."

НЕ давай общие фразы типа "верь в себя" или "ты справишься" - только конкретные, действенные техники!`;
  }

  private getDefaultUserPrompt(messageType: string): string {
    const prompts = {
      motivation: 'Мотивируй меня продолжать развиваться!',
      task_suggestion: 'Помоги оптимизировать мои задачи.',
      habit_advice:
        'Дай персональные советы по каждой из моих привычек: как улучшить те, что идут хорошо, и как возобновить те, с которыми есть проблемы. Нужны конкретные действенные техники, а не общие слова поддержки.',
      mood_analysis: 'Проанализируй мое настроение.',
      focus_tips: 'Как лучше сфокусироваться на задачах?',
      dependency_help: 'Помоги справиться с вредными привычками.',
    };
    return prompts[messageType] || prompts.motivation;
  }

  private getFallbackMessage(
    messageType: string,
    context: UserContext,
  ): string {
    const messages = {
      motivation: `🚀 ${context.name || 'Друг'}, ты на правильном пути! У тебя ${context.totalXp || 0} XP и стрик ${context.currentStreak || 0} дней. Продолжай двигаться к своим целям!`,
      task_suggestion:
        '📝 Сосредоточься на важных задачах, разбивай большие на маленькие части, и не забывай отмечать прогресс!',
      habit_advice:
        '🔄 Начинай с малого, будь последователен, отмечай успехи. Каждый день - это новая возможность!',
      mood_analysis:
        '😊 Твое настроение влияет на продуктивность. Попробуй техники релаксации и не забывай про отдых.',
      focus_tips:
        '🍅 Используй технику Помодоро: 25 минут фокуса, 5 минут отдых. Убери отвлекающие факторы!',
      dependency_help:
        '💪 Борьба с зависимостью - это марафон, а не спринт. Вот несколько конкретных шагов:\n\n1. 🎯 Определи триггеры: когда и почему возникает желание?\n2. 🔄 Замени привычку: вместо курения - дыхательные упражнения или стакан воды\n3. 📊 Отслеживай прогресс: каждый день без зависимости - это победа\n4. 🤝 Обратись за поддержкой: не стесняйся просить помощи\n5. 💡 Помни: срывы - это часть процесса, не сдавайся!\n\nТы сильнее своей зависимости! Каждый день без неё приближает тебя к свободе. 🚀',
    };
    return messages[messageType] || messages.motivation;
  }

  async analyzeProductivity(userId: string): Promise<string> {
    const context = await this.getUserContext(userId);

    const completedTasks =
      context.tasks?.filter((t) => t.completed).length || 0;
    const totalTasks = context.tasks?.length || 0;
    const completionRate =
      totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    const recentMood = context.moodHistory?.[0]?.mood || 'неизвестно';

    return this.generatePersonalizedMessage(
      userId,
      'task_suggestion',
      `Проанализируй мою продуктивность: выполнено ${completedTasks} из ${totalTasks} задач (${completionRate}%), текущее настроение: ${recentMood}, стрик: ${context.currentStreak} дней. Дай персонализированные советы по улучшению.`,
    );
  }

  async generateDailyMotivation(userId: string): Promise<string> {
    return this.generatePersonalizedMessage(
      userId,
      'motivation',
      'Мотивируй меня на новый продуктивный день!',
    );
  }

  async analyzeMoodPattern(userId: string): Promise<string> {
    return this.generatePersonalizedMessage(
      userId,
      'mood_analysis',
      'Проанализируй мои паттерны настроения и дай советы по улучшению эмоционального состояния.',
    );
  }
}
