/*
  Warnings:

  - The values [MOOD,CUSTOM] on the enum `ReminderType` will be removed. If these variants are still used in the database, this will fail.

*/
-- CreateEnum
CREATE TYPE "public"."SubscriptionType" AS ENUM ('FREE', 'PREMIUM', 'PREMIUM_PLUS');

-- CreateEnum
CREATE TYPE "public"."PaymentStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'REFUNDED');

-- AlterEnum
BEGIN;
CREATE TYPE "public"."ReminderType_new" AS ENUM ('TASK', 'HABIT', 'GENERAL');
ALTER TABLE "public"."reminders" ALTER COLUMN "type" TYPE "public"."ReminderType_new" USING ("type"::text::"public"."ReminderType_new");
ALTER TYPE "public"."ReminderType" RENAME TO "ReminderType_old";
ALTER TYPE "public"."ReminderType_new" RENAME TO "ReminderType";
DROP TYPE "public"."ReminderType_old";
COMMIT;

-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "daily_ai_queries_used" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "daily_habits_used" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "daily_reminders_used" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "daily_tasks_used" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "is_trial_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "last_usage_reset" TIMESTAMP(3),
ADD COLUMN     "subscription_ends" TIMESTAMP(3),
ADD COLUMN     "subscription_started" TIMESTAMP(3),
ADD COLUMN     "subscription_type" "public"."SubscriptionType" NOT NULL DEFAULT 'FREE',
ADD COLUMN     "trial_ends" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "public"."payments" (
    "id" TEXT NOT NULL,
    "user_id" VARCHAR(50) NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "status" "public"."PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "subscription_type" "public"."SubscriptionType" NOT NULL,
    "payment_method" TEXT,
    "transaction_id" TEXT,
    "provider_response" TEXT,
    "billing_period_start" TIMESTAMP(3) NOT NULL,
    "billing_period_end" TIMESTAMP(3) NOT NULL,
    "paid_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_transaction_id_key" ON "public"."payments"("transaction_id");

-- AddForeignKey
ALTER TABLE "public"."payments" ADD CONSTRAINT "payments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
