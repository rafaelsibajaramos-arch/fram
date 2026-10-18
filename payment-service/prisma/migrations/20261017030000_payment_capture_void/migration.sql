ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'captured';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'voided';
ALTER TYPE "WalletTransactionType" ADD VALUE IF NOT EXISTS 'release';
