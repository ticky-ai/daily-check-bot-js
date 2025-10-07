import { Test, TestingModule } from '@nestjs/testing';
import { TelegramBotService } from './telegram-bot.service';
import { UserService } from '../services/user.service';
import { PrismaService } from '../database/prisma.service';

describe('ReferralSystem', () => {
  let botService: TelegramBotService;
  let userService: UserService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramBotService,
        {
          provide: UserService,
          useValue: {
            findByTelegramId: jest.fn(),
            updateUser: jest.fn(),
            createUser: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            user: {
              count: jest.fn(),
              findMany: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    botService = module.get<TelegramBotService>(TelegramBotService);
    userService = module.get<UserService>(UserService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('getReferralsCount', () => {
    it('should return correct referrals count', async () => {
      // Mock user
      jest.spyOn(userService, 'findByTelegramId').mockResolvedValue({
        id: 'user1',
        totalXp: 1000,
      } as any);

      // Mock referrals count
      jest.spyOn(prisma.user, 'count').mockResolvedValue(3);

      const count = await (botService as any).getReferralsCount('user1');
      expect(count).toBe(3);
    });

    it('should return 0 on error', async () => {
      jest
        .spyOn(userService, 'findByTelegramId')
        .mockRejectedValue(new Error('User not found'));

      const count = await (botService as any).getReferralsCount('user1');
      expect(count).toBe(0);
    });
  });

  describe('getReferralStats', () => {
    it('should return correct referral statistics', async () => {
      const mockUser = { id: 'user1', totalXp: 1000 };
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      const mockReferrals = [
        {
          firstName: 'John',
          username: 'john_doe',
          createdAt: new Date(),
          lastActivity: new Date(), // Active user
        },
        {
          firstName: 'Jane',
          username: 'jane_doe',
          createdAt: new Date(),
          lastActivity: new Date(weekAgo.getTime() - 86400000), // Inactive user
        },
      ];

      jest
        .spyOn(userService, 'findByTelegramId')
        .mockResolvedValue(mockUser as any);
      jest
        .spyOn(prisma.user, 'findMany')
        .mockResolvedValue(mockReferrals as any);

      const stats = await (botService as any).getReferralStats('user1');

      expect(stats.totalReferrals).toBe(2);
      expect(stats.activeReferrals).toBe(1);
      expect(stats.totalBonus).toBe(1200); // 2*500 + 200 (first friend bonus)
      expect(stats.topReferrals).toHaveLength(2);
      expect(stats.topReferrals[0].name).toBe('John');
      expect(stats.topReferrals[0].isActive).toBe(true);
      expect(stats.topReferrals[1].name).toBe('Jane');
      expect(stats.topReferrals[1].isActive).toBe(false);
    });
  });
});
