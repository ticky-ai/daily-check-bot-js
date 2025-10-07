/*
  Warnings:

  - The values [PREMIUM_PLUS] on the enum `SubscriptionType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "public"."SubscriptionType_new" AS ENUM ('FREE', 'PREMIUM');
ALTER TABLE "public"."users" ALTER COLUMN "subscription_type" DROP DEFAULT;
ALTER TABLE "public"."users" ALTER COLUMN "subscription_type" TYPE "public"."SubscriptionType_new" USING ("subscription_type"::text::"public"."SubscriptionType_new");
ALTER TABLE "public"."payments" ALTER COLUMN "subscription_type" TYPE "public"."SubscriptionType_new" USING ("subscription_type"::text::"public"."SubscriptionType_new");
ALTER TYPE "public"."SubscriptionType" RENAME TO "SubscriptionType_old";
ALTER TYPE "public"."SubscriptionType_new" RENAME TO "SubscriptionType";
DROP TYPE "public"."SubscriptionType_old";
ALTER TABLE "public"."users" ALTER COLUMN "subscription_type" SET DEFAULT 'FREE';
COMMIT;
