import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { MoodEntry, MoodType } from '@prisma/client';
import { CreateMoodEntryDto, UpdateMoodEntryDto } from '../dto';

@Injectable()
export class MoodService {
  private readonly logger = new Logger(MoodService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createMoodEntry(
    createMoodEntryDto: CreateMoodEntryDto,
  ): Promise<MoodEntry> {
    const moodEntry = await this.prisma.moodEntry.create({
      data: createMoodEntryDto,
    });

    this.logger.log(
      `Created mood entry: ${moodEntry.id} for user: ${moodEntry.userId}`,
    );
    return moodEntry;
  }

  async findMoodEntriesByUserId(
    userId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<MoodEntry[]> {
    const where: any = { userId };

    if (startDate && endDate) {
      where.createdAt = {
        gte: startDate,
        lte: endDate,
      };
    }

    return await this.prisma.moodEntry.findMany({
      where,
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findMoodEntryById(entryId: string, userId: string): Promise<MoodEntry> {
    const moodEntry = await this.prisma.moodEntry.findFirst({
      where: {
        id: entryId,
        userId,
      },
    });

    if (!moodEntry) {
      throw new NotFoundException(`Mood entry with ID ${entryId} not found`);
    }

    return moodEntry;
  }

  async updateMoodEntry(
    entryId: string,
    userId: string,
    updateMoodEntryDto: UpdateMoodEntryDto,
  ): Promise<MoodEntry> {
    await this.findMoodEntryById(entryId, userId); // Ensure entry exists and belongs to user

    const moodEntry = await this.prisma.moodEntry.update({
      where: { id: entryId },
      data: updateMoodEntryDto,
    });

    this.logger.log(`Updated mood entry: ${moodEntry.id}`);
    return moodEntry;
  }

  async deleteMoodEntry(entryId: string, userId: string): Promise<void> {
    await this.findMoodEntryById(entryId, userId); // Ensure entry exists and belongs to user

    await this.prisma.moodEntry.delete({
      where: { id: entryId },
    });

    this.logger.log(`Deleted mood entry: ${entryId}`);
  }

  async getTodayMoodEntry(userId: string): Promise<MoodEntry | null> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    return await this.prisma.moodEntry.findFirst({
      where: {
        userId,
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async getMoodStats(
    userId: string,
    days = 30,
  ): Promise<{
    averageRating: number;
    mostCommonMood: MoodType;
    totalEntries: number;
    moodDistribution: Record<MoodType, number>;
  }> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const moodEntries = await this.prisma.moodEntry.findMany({
      where: {
        userId,
        createdAt: {
          gte: startDate,
        },
      },
      select: {
        mood: true,
        rating: true,
      },
    });

    if (moodEntries.length === 0) {
      return {
        averageRating: 0,
        mostCommonMood: MoodType.NEUTRAL,
        totalEntries: 0,
        moodDistribution: {
          [MoodType.VERY_SAD]: 0,
          [MoodType.SAD]: 0,
          [MoodType.NEUTRAL]: 0,
          [MoodType.HAPPY]: 0,
          [MoodType.VERY_HAPPY]: 0,
        },
      };
    }

    const averageRating =
      moodEntries.reduce((sum, entry) => sum + entry.rating, 0) /
      moodEntries.length;

    const moodDistribution = moodEntries.reduce(
      (acc, entry) => {
        acc[entry.mood] = (acc[entry.mood] || 0) + 1;
        return acc;
      },
      {} as Record<MoodType, number>,
    );

    const mostCommonMood = Object.keys(moodDistribution).reduce((a, b) =>
      moodDistribution[a as MoodType] > moodDistribution[b as MoodType] ? a : b,
    ) as MoodType;

    return {
      averageRating: Math.round(averageRating * 10) / 10,
      mostCommonMood,
      totalEntries: moodEntries.length,
      moodDistribution: {
        [MoodType.VERY_SAD]: moodDistribution[MoodType.VERY_SAD] || 0,
        [MoodType.SAD]: moodDistribution[MoodType.SAD] || 0,
        [MoodType.NEUTRAL]: moodDistribution[MoodType.NEUTRAL] || 0,
        [MoodType.HAPPY]: moodDistribution[MoodType.HAPPY] || 0,
        [MoodType.VERY_HAPPY]: moodDistribution[MoodType.VERY_HAPPY] || 0,
      },
    };
  }
}
