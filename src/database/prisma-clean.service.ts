import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: ['warn', 'error'],
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      this.logger.log('🗄️ Connected to database successfully');
    } catch (error) {
      this.logger.error('❌ Failed to connect to database:', error);
      throw error;
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('🔌 Disconnected from database');
  }

  async cleanDatabase() {
    // For development/testing purposes
    const modelNames = [
      'userAchievement',
      'achievement',
      'reminder',
      'focusSession',
      'moodEntry',
      'habit',
      'task',
      'user',
    ];

    // Delete in order to respect foreign key constraints
    for (const modelName of modelNames) {
      const model = this[modelName as keyof PrismaClient];
      if (model && typeof model === 'object' && 'deleteMany' in model) {
        await (model as any).deleteMany();
      }
    }
  }
}
