-- CreateEnum
CREATE TYPE "public"."DependencyType" AS ENUM ('SMOKING', 'ALCOHOL', 'GAMBLING', 'SWEET', 'SOCIAL_MEDIA', 'GAMING', 'OTHER');

-- CreateEnum
CREATE TYPE "public"."DependencyStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "public"."dependency_support" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "public"."DependencyType" NOT NULL,
    "custom_name" TEXT,
    "status" "public"."DependencyStatus" NOT NULL DEFAULT 'ACTIVE',
    "morning_time" TEXT NOT NULL DEFAULT '09:00',
    "evening_time" TEXT NOT NULL DEFAULT '21:00',
    "days_clean" INTEGER NOT NULL DEFAULT 0,
    "total_promises" INTEGER NOT NULL DEFAULT 0,
    "kept_promises" INTEGER NOT NULL DEFAULT 0,
    "last_promise_date" TIMESTAMP(3),
    "last_check_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dependency_support_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "public"."dependency_support" ADD CONSTRAINT "dependency_support_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
