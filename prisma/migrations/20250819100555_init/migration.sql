-- CreateEnum
CREATE TYPE "public"."TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "public"."HabitFrequency" AS ENUM ('DAILY', 'WEEKLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "public"."MoodType" AS ENUM ('VERY_SAD', 'SAD', 'NEUTRAL', 'HAPPY', 'VERY_HAPPY');

-- CreateEnum
CREATE TYPE "public"."FocusSessionStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."ReminderType" AS ENUM ('TASK', 'HABIT', 'MOOD', 'CUSTOM');

-- CreateEnum
CREATE TYPE "public"."ReminderStatus" AS ENUM ('ACTIVE', 'SNOOZED', 'DISMISSED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "public"."AchievementRarity" AS ENUM ('COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY');

-- CreateTable
CREATE TABLE "public"."users" (
    "id" VARCHAR(50) NOT NULL,
    "username" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "theme" TEXT NOT NULL DEFAULT 'default',
    "notifications" BOOLEAN NOT NULL DEFAULT true,
    "onboarding_passed" BOOLEAN NOT NULL DEFAULT false,
    "ai_mode" BOOLEAN NOT NULL DEFAULT true,
    "dry_mode" BOOLEAN NOT NULL DEFAULT false,
    "show_animations" BOOLEAN NOT NULL DEFAULT true,
    "voice_commands" BOOLEAN NOT NULL DEFAULT true,
    "daily_reminders" BOOLEAN NOT NULL DEFAULT true,
    "reminder_time" TEXT NOT NULL DEFAULT '09:00',
    "weekly_summary" BOOLEAN NOT NULL DEFAULT true,
    "privacy_level" TEXT NOT NULL DEFAULT 'public',
    "total_tasks" INTEGER NOT NULL DEFAULT 0,
    "completed_tasks" INTEGER NOT NULL DEFAULT 0,
    "total_habits" INTEGER NOT NULL DEFAULT 0,
    "completed_habits" INTEGER NOT NULL DEFAULT 0,
    "current_streak" INTEGER NOT NULL DEFAULT 0,
    "max_streak" INTEGER NOT NULL DEFAULT 0,
    "total_xp" INTEGER NOT NULL DEFAULT 0,
    "level" INTEGER NOT NULL DEFAULT 1,
    "today_tasks" INTEGER NOT NULL DEFAULT 0,
    "today_habits" INTEGER NOT NULL DEFAULT 0,
    "week_streak" INTEGER NOT NULL DEFAULT 0,
    "month_streak" INTEGER NOT NULL DEFAULT 0,
    "focus_time_total" INTEGER NOT NULL DEFAULT 0,
    "referrals_count" INTEGER NOT NULL DEFAULT 0,
    "active_referrals" INTEGER NOT NULL DEFAULT 0,
    "challenges_won" INTEGER NOT NULL DEFAULT 0,
    "challenges_participated" INTEGER NOT NULL DEFAULT 0,
    "avatar" TEXT NOT NULL DEFAULT 'default',
    "background" TEXT NOT NULL DEFAULT 'default',
    "stickers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unlocked_themes" TEXT[] DEFAULT ARRAY['default']::TEXT[],
    "unlocked_avatars" TEXT[] DEFAULT ARRAY['default']::TEXT[],
    "unlocked_backgrounds" TEXT[] DEFAULT ARRAY['default']::TEXT[],
    "referral_code" TEXT,
    "referred_by" TEXT,
    "last_activity" TIMESTAMP(3),
    "timezone" TEXT,
    "city" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."tasks" (
    "id" TEXT NOT NULL,
    "user_id" VARCHAR(50) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "public"."TaskStatus" NOT NULL DEFAULT 'PENDING',
    "priority" "public"."TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "due_date" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "xp_reward" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_recurring" BOOLEAN NOT NULL DEFAULT false,
    "recurrence_pattern" TEXT,
    "estimated_duration" INTEGER NOT NULL DEFAULT 0,
    "actual_duration" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."habits" (
    "id" TEXT NOT NULL,
    "user_id" VARCHAR(50) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "frequency" "public"."HabitFrequency" NOT NULL DEFAULT 'DAILY',
    "target_count" INTEGER NOT NULL DEFAULT 1,
    "current_streak" INTEGER NOT NULL DEFAULT 0,
    "max_streak" INTEGER NOT NULL DEFAULT 0,
    "total_completions" INTEGER NOT NULL DEFAULT 0,
    "xp_reward" INTEGER NOT NULL DEFAULT 5,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "reminder_time" TEXT,
    "reminder_days" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "icon" TEXT,
    "color" TEXT,
    "difficulty" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "habits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."mood_entries" (
    "id" TEXT NOT NULL,
    "user_id" VARCHAR(50) NOT NULL,
    "mood" "public"."MoodType" NOT NULL,
    "rating" INTEGER NOT NULL DEFAULT 5,
    "note" TEXT,
    "emotions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "factors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mood_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."focus_sessions" (
    "id" TEXT NOT NULL,
    "user_id" VARCHAR(50) NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "planned_duration" INTEGER NOT NULL DEFAULT 25,
    "actual_duration" INTEGER NOT NULL DEFAULT 0,
    "status" "public"."FocusSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "breaks_taken" INTEGER NOT NULL DEFAULT 0,
    "break_duration" INTEGER NOT NULL DEFAULT 0,
    "category" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "productivity_rating" INTEGER NOT NULL DEFAULT 5,
    "xp_reward" INTEGER NOT NULL DEFAULT 10,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "focus_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."achievements" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "rarity" "public"."AchievementRarity" NOT NULL DEFAULT 'COMMON',
    "max_progress" INTEGER NOT NULL DEFAULT 0,
    "xp_reward" INTEGER NOT NULL DEFAULT 0,
    "badge_reward" TEXT,
    "conditions" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."user_achievements" (
    "id" TEXT NOT NULL,
    "user_id" VARCHAR(50) NOT NULL,
    "achievement_id" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_achievements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."reminders" (
    "id" TEXT NOT NULL,
    "user_id" VARCHAR(50) NOT NULL,
    "type" "public"."ReminderType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "scheduled_time" TIMESTAMP(3) NOT NULL,
    "status" "public"."ReminderStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_recurring" BOOLEAN NOT NULL DEFAULT false,
    "recurrence_pattern" TEXT,
    "related_entity_id" TEXT,
    "snooze_until" TIMESTAMP(3),
    "snooze_count" INTEGER NOT NULL DEFAULT 0,
    "dismissed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_referral_code_key" ON "public"."users"("referral_code");

-- CreateIndex
CREATE UNIQUE INDEX "user_achievements_user_id_achievement_id_key" ON "public"."user_achievements"("user_id", "achievement_id");

-- AddForeignKey
ALTER TABLE "public"."users" ADD CONSTRAINT "users_referred_by_fkey" FOREIGN KEY ("referred_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."habits" ADD CONSTRAINT "habits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."mood_entries" ADD CONSTRAINT "mood_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."focus_sessions" ADD CONSTRAINT "focus_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_achievements" ADD CONSTRAINT "user_achievements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."user_achievements" ADD CONSTRAINT "user_achievements_achievement_id_fkey" FOREIGN KEY ("achievement_id") REFERENCES "public"."achievements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."reminders" ADD CONSTRAINT "reminders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
