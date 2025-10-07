import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { FocusSession, FocusSessionStatus } from '@prisma/client';
import { CreateFocusSessionDto, UpdateFocusSessionDto } from '../dto';

@Injectable()
export class FocusService {
  private readonly logger = new Logger(FocusService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createFocusSession(
    createFocusSessionDto: CreateFocusSessionDto,
  ): Promise<FocusSession> {
    const focusSession = await this.prisma.focusSession.create({
      data: {
        ...createFocusSessionDto,
        startedAt: new Date(),
      },
    });

    this.logger.log(
      `Created focus session: ${focusSession.id} for user: ${focusSession.userId}`,
    );
    return focusSession;
  }

  async findFocusSessionsByUserId(userId: string): Promise<FocusSession[]> {
    return await this.prisma.focusSession.findMany({
      where: { userId },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findFocusSessionById(
    sessionId: string,
    userId: string,
  ): Promise<FocusSession> {
    const focusSession = await this.prisma.focusSession.findFirst({
      where: {
        id: sessionId,
        userId,
      },
    });

    if (!focusSession) {
      throw new NotFoundException(
        `Focus session with ID ${sessionId} not found`,
      );
    }

    return focusSession;
  }

  async updateFocusSession(
    sessionId: string,
    userId: string,
    updateFocusSessionDto: UpdateFocusSessionDto,
  ): Promise<FocusSession> {
    await this.findFocusSessionById(sessionId, userId); // Ensure session exists and belongs to user

    const focusSession = await this.prisma.focusSession.update({
      where: { id: sessionId },
      data: updateFocusSessionDto,
    });

    this.logger.log(`Updated focus session: ${focusSession.id}`);
    return focusSession;
  }

  async completeFocusSession(
    sessionId: string,
    userId: string,
    actualDuration: number,
    productivityRating = 5,
  ): Promise<{ session: FocusSession; xpGained: number }> {
    const session = await this.findFocusSessionById(sessionId, userId);

    if (session.status === FocusSessionStatus.COMPLETED) {
      throw new Error('Focus session is already completed');
    }

    const xpGained = Math.floor(actualDuration / 5); // 1 XP per 5 minutes

    const updatedSession = await this.prisma.focusSession.update({
      where: { id: sessionId },
      data: {
        status: FocusSessionStatus.COMPLETED,
        actualDuration,
        endedAt: new Date(),
        productivityRating,
        xpReward: xpGained,
      },
    });

    this.logger.log(
      `Completed focus session: ${sessionId}, XP gained: ${xpGained}`,
    );
    return { session: updatedSession, xpGained };
  }

  async pauseFocusSession(
    sessionId: string,
    userId: string,
  ): Promise<FocusSession> {
    const session = await this.findFocusSessionById(sessionId, userId);

    if (session.status !== FocusSessionStatus.ACTIVE) {
      throw new Error('Can only pause active focus sessions');
    }

    const updatedSession = await this.prisma.focusSession.update({
      where: { id: sessionId },
      data: {
        status: FocusSessionStatus.PAUSED,
      },
    });

    this.logger.log(`Paused focus session: ${sessionId}`);
    return updatedSession;
  }

  async resumeFocusSession(
    sessionId: string,
    userId: string,
  ): Promise<FocusSession> {
    const session = await this.findFocusSessionById(sessionId, userId);

    if (session.status !== FocusSessionStatus.PAUSED) {
      throw new Error('Can only resume paused focus sessions');
    }

    const updatedSession = await this.prisma.focusSession.update({
      where: { id: sessionId },
      data: {
        status: FocusSessionStatus.ACTIVE,
      },
    });

    this.logger.log(`Resumed focus session: ${sessionId}`);
    return updatedSession;
  }

  async getActiveFocusSession(userId: string): Promise<FocusSession | null> {
    return await this.prisma.focusSession.findFirst({
      where: {
        userId,
        status: {
          in: [FocusSessionStatus.ACTIVE, FocusSessionStatus.PAUSED],
        },
      },
      orderBy: {
        startedAt: 'desc',
      },
    });
  }

  async getTodayFocusTime(userId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const completedSessions = await this.prisma.focusSession.findMany({
      where: {
        userId,
        status: FocusSessionStatus.COMPLETED,
        endedAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      select: {
        actualDuration: true,
      },
    });

    return completedSessions.reduce(
      (total, session) => total + session.actualDuration,
      0,
    );
  }

  async getFocusStats(
    userId: string,
    days = 30,
  ): Promise<{
    totalSessions: number;
    completedSessions: number;
    totalFocusTime: number; // in minutes
    averageSessionLength: number; // in minutes
    averageProductivityRating: number;
    completionRate: number; // percentage
  }> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const [allSessions, completedSessions] = await Promise.all([
      this.prisma.focusSession.findMany({
        where: {
          userId,
          createdAt: {
            gte: startDate,
          },
        },
        select: {
          status: true,
          actualDuration: true,
          productivityRating: true,
        },
      }),
      this.prisma.focusSession.findMany({
        where: {
          userId,
          status: FocusSessionStatus.COMPLETED,
          createdAt: {
            gte: startDate,
          },
        },
        select: {
          actualDuration: true,
          productivityRating: true,
        },
      }),
    ]);

    const totalSessions = allSessions.length;
    const completedSessionsCount = completedSessions.length;
    const totalFocusTime = completedSessions.reduce(
      (sum, session) => sum + session.actualDuration,
      0,
    );
    const averageSessionLength =
      completedSessionsCount > 0 ? totalFocusTime / completedSessionsCount : 0;
    const averageProductivityRating =
      completedSessionsCount > 0
        ? completedSessions.reduce(
            (sum, session) => sum + session.productivityRating,
            0,
          ) / completedSessionsCount
        : 0;
    const completionRate =
      totalSessions > 0 ? (completedSessionsCount / totalSessions) * 100 : 0;

    return {
      totalSessions,
      completedSessions: completedSessionsCount,
      totalFocusTime,
      averageSessionLength: Math.round(averageSessionLength),
      averageProductivityRating:
        Math.round(averageProductivityRating * 10) / 10,
      completionRate: Math.round(completionRate),
    };
  }
}
