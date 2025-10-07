import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

@Injectable()
export class OpenAIService {
  private readonly logger = new Logger(OpenAIService.name);
  private openai: OpenAI;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('openai.apiKey');
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not provided');
    }

    this.openai = new OpenAI({
      apiKey: apiKey,
    });
  }

  async getTimezoneByCity(
    city: string,
  ): Promise<{ timezone: string; normalizedCity: string } | null> {
    try {
      const prompt = `
Определи часовой пояс для города: ${city}

Ответь ТОЛЬКО в формате JSON без дополнительного текста:
{
  "timezone": "Europe/Moscow",
  "normalizedCity": "Москва"
}

Где:
- timezone - стандартное название часового пояса в формате IANA (например: Europe/Moscow, America/New_York, Asia/Tokyo)
- normalizedCity - правильное название города на русском языке

Если город не найден или некорректен, верни null.
      `;

      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.1,
        max_tokens: 100,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content || content === 'null') {
        return null;
      }

      const result = JSON.parse(content);

      if (result.timezone && result.normalizedCity) {
        return {
          timezone: result.timezone,
          normalizedCity: result.normalizedCity,
        };
      }

      return null;
    } catch (error) {
      this.logger.error('Error getting timezone by city:', error);
      return null;
    }
  }

  async getAIResponse(prompt: string): Promise<string> {
    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          {
            role: 'system',
            content:
              'Ты персональный ассистент по продуктивности. Даешь краткие, практичные советы на русском языке. Отвечай дружелюбно и мотивирующе. Важно: всегда завершай свой ответ полностью, не обрывай на середине предложения или пункта.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.7,
        max_tokens: 1500,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        throw new Error('Empty response from OpenAI');
      }

      return content;
    } catch (error) {
      this.logger.error('Error getting AI response:', error);
      throw new Error('Не удалось получить ответ от ИИ-консультанта');
    }
  }

  async transcribeAudio(audioFile: File): Promise<string | null> {
    try {
      this.logger.log(
        `Starting audio transcription for file: ${audioFile.name}, size: ${audioFile.size} bytes`,
      );

      const transcription = await this.openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        language: 'ru', // Russian language
        response_format: 'text',
      });

      this.logger.log(
        `Transcription completed successfully: "${transcription}"`,
      );
      return transcription || null;
    } catch (error) {
      this.logger.error('Error transcribing audio:', error);

      // Log more details about the error
      if (error instanceof Error) {
        this.logger.error(`Error message: ${error.message}`);
        this.logger.error(`Error stack: ${error.stack}`);
      }

      return null;
    }
  }

  /**
   * Советы по задачам (анализ продуктивности)
   */
  async getTaskAdvice(userId: string, aiContextService: any): Promise<string> {
    // Использует глубокий анализ профиля пользователя
    return aiContextService.analyzeProductivity(userId);
  }

  /**
   * Помощь с привычками
   */
  async getHabitHelp(userId: string, aiContextService: any): Promise<string> {
    // Персонализированный совет по привычкам
    return aiContextService.generatePersonalizedMessage(userId, 'habit_advice');
  }

  /**
   * Планирование времени (фокус)
   */
  async getTimePlanning(
    userId: string,
    aiContextService: any,
  ): Promise<string> {
    // Персонализированный совет по фокусу и планированию
    return aiContextService.generatePersonalizedMessage(userId, 'focus_tips');
  }
}
