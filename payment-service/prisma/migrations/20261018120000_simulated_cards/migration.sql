CREATE TABLE "simulated_cards" (
  "id" UUID NOT NULL,
  "walletId" UUID NOT NULL,
  "brand" VARCHAR(24) NOT NULL,
  "last4" VARCHAR(4) NOT NULL,
  "holderName" VARCHAR(120) NOT NULL,
  "expiry_month" INTEGER NOT NULL,
  "expiry_year" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "simulated_cards_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "simulated_cards_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "simulated_cards_walletId_created_at_idx" ON "simulated_cards"("walletId", "created_at");
ALTER TABLE "payments" ADD COLUMN "simulated_card_id" UUID;
ALTER TABLE "payments" ADD COLUMN "simulated_card_brand" VARCHAR(20);
ALTER TABLE "payments" ADD COLUMN "simulated_card_last4" VARCHAR(4);
