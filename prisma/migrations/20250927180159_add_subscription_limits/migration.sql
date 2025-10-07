-- AlterTable
ALTER TABLE "public"."dependency_support" ADD COLUMN     "last_evening_sent" TIMESTAMP(3),
ADD COLUMN     "last_morning_sent" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."habits" ADD COLUMN     "last_completed_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "daily_ai_requests" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "daily_pomodoro_sessions" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "is_premium" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "last_daily_reset" TIMESTAMP(3);
