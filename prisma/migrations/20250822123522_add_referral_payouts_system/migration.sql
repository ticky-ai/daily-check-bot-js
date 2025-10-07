-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "referral_balance" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."referral_payouts" (
    "id" TEXT NOT NULL,
    "referrer_id" TEXT NOT NULL,
    "referred_user_id" TEXT NOT NULL,
    "payment_id" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "original_amount" DOUBLE PRECISION NOT NULL,
    "percentage" INTEGER NOT NULL DEFAULT 40,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),

    CONSTRAINT "referral_payouts_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "public"."referral_payouts" ADD CONSTRAINT "referral_payouts_referrer_id_fkey" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."referral_payouts" ADD CONSTRAINT "referral_payouts_referred_user_id_fkey" FOREIGN KEY ("referred_user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."referral_payouts" ADD CONSTRAINT "referral_payouts_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
