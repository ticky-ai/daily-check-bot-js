/*
  Warnings:

  - A unique constraint covering the columns `[user_id,type]` on the table `dependency_support` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."focus_sessions" ADD COLUMN     "paused_at" TIMESTAMP(3),
ADD COLUMN     "total_paused_time" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."habit_skips" (
    "id" TEXT NOT NULL,
    "user_id" VARCHAR(50) NOT NULL,
    "habit_id" TEXT NOT NULL,
    "skip_date" DATE NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "habit_skips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "habit_skips_user_id_habit_id_skip_date_key" ON "public"."habit_skips"("user_id", "habit_id", "skip_date");

-- CreateIndex
CREATE UNIQUE INDEX "dependency_support_user_id_type_key" ON "public"."dependency_support"("user_id", "type");

-- AddForeignKey
ALTER TABLE "public"."habit_skips" ADD CONSTRAINT "habit_skips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."habit_skips" ADD CONSTRAINT "habit_skips_habit_id_fkey" FOREIGN KEY ("habit_id") REFERENCES "public"."habits"("id") ON DELETE CASCADE ON UPDATE CASCADE;
