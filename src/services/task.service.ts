import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { Task, TaskStatus, TaskPriority } from '@prisma/client';
import { CreateTaskDto, UpdateTaskDto } from '../dto';

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createTask(createTaskDto: CreateTaskDto): Promise<Task> {
    const task = await this.prisma.task.create({
      data: {
        ...createTaskDto,
        xpReward:
          createTaskDto.xpReward ||
          this.calculateXpReward(createTaskDto.priority || TaskPriority.MEDIUM),
      },
    });

    this.logger.log(`Created task: ${task.id} for user: ${task.userId}`);
    return task;
  }

  async findTasksByUserId(
    userId: string,
    status?: TaskStatus,
  ): Promise<Task[]> {
    return await this.prisma.task.findMany({
      where: {
        userId,
        ...(status && { status }),
      },
      orderBy: [
        { priority: 'desc' },
        { dueDate: 'asc' },
        { createdAt: 'desc' },
      ],
    });
  }

  async findTaskById(taskId: string, userId: string): Promise<Task> {
    const task = await this.prisma.task.findFirst({
      where: {
        id: taskId,
        userId,
      },
    });

    if (!task) {
      throw new NotFoundException(`Task with ID ${taskId} not found`);
    }

    return task;
  }

  async updateTask(
    taskId: string,
    userId: string,
    updateTaskDto: UpdateTaskDto,
  ): Promise<Task> {
    // Verify the task exists and belongs to the user
    await this.findTaskById(taskId, userId);

    const task = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        ...updateTaskDto,
        ...(updateTaskDto.status === TaskStatus.COMPLETED && {
          completedAt: new Date(),
        }),
      },
    });

    this.logger.log(`Updated task: ${task.id}`);
    return task;
  }

  async deleteTask(taskId: string, userId: string): Promise<void> {
    await this.findTaskById(taskId, userId); // Ensure task exists and belongs to user

    await this.prisma.task.delete({
      where: { id: taskId },
    });

    this.logger.log(`Deleted task: ${taskId}`);
  }

  async completeTask(
    taskId: string,
    userId: string,
  ): Promise<{ task: Task; xpGained: number }> {
    const task = await this.findTaskById(taskId, userId);

    if (task.status === TaskStatus.COMPLETED) {
      throw new Error('Task is already completed');
    }

    const updatedTask = await this.prisma.task.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.COMPLETED,
        completedAt: new Date(),
      },
    });

    this.logger.log(`Completed task: ${taskId}, XP gained: ${task.xpReward}`);
    return { task: updatedTask, xpGained: task.xpReward };
  }

  async getTodayTasks(userId: string): Promise<Task[]> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    return await this.prisma.task.findMany({
      where: {
        userId,
        OR: [
          {
            dueDate: {
              gte: startOfDay,
              lte: endOfDay,
            },
          },
          {
            dueDate: null,
            createdAt: {
              gte: startOfDay,
            },
          },
        ],
      },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
    });
  }

  async getOverdueTasks(userId: string): Promise<Task[]> {
    const now = new Date();

    return await this.prisma.task.findMany({
      where: {
        userId,
        status: {
          not: TaskStatus.COMPLETED,
        },
        dueDate: {
          lt: now,
        },
      },
      orderBy: { dueDate: 'asc' },
    });
  }

  async getTaskStats(userId: string): Promise<{
    total: number;
    completed: number;
    pending: number;
    inProgress: number;
    overdue: number;
    todayCompleted: number;
  }> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);
    const now = new Date();

    const [total, completed, pending, inProgress, overdue, todayCompleted] =
      await Promise.all([
        this.prisma.task.count({ where: { userId } }),
        this.prisma.task.count({
          where: { userId, status: TaskStatus.COMPLETED },
        }),
        this.prisma.task.count({
          where: { userId, status: TaskStatus.PENDING },
        }),
        this.prisma.task.count({
          where: { userId, status: TaskStatus.IN_PROGRESS },
        }),
        this.prisma.task.count({
          where: {
            userId,
            status: { not: TaskStatus.COMPLETED },
            dueDate: { lt: now },
          },
        }),
        this.prisma.task.count({
          where: {
            userId,
            status: TaskStatus.COMPLETED,
            completedAt: { gte: startOfDay, lte: endOfDay },
          },
        }),
      ]);

    return {
      total,
      completed,
      pending,
      inProgress,
      overdue,
      todayCompleted,
    };
  }

  async searchTasks(userId: string, query: string): Promise<Task[]> {
    return await this.prisma.task.findMany({
      where: {
        userId,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          { category: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
    });
  }

  private calculateXpReward(priority: TaskPriority): number {
    const xpMap = {
      [TaskPriority.LOW]: 5,
      [TaskPriority.MEDIUM]: 10,
      [TaskPriority.HIGH]: 15,
      [TaskPriority.URGENT]: 20,
    };

    return xpMap[priority] || 10;
  }
}
