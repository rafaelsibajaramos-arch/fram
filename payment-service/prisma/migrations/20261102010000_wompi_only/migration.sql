-- Keep historical simulator tables as read-only legacy records. No balances
-- are converted into provider money, and no historical records are deleted.
ALTER TABLE payments ADD COLUMN provider TEXT NOT NULL DEFAULT 'legacy_simulator';
ALTER TABLE payments ALTER COLUMN provider SET DEFAULT 'wompi';
ALTER TABLE payments ADD COLUMN "providerReference" TEXT;
ALTER TABLE payments ADD COLUMN "providerTransactionId" TEXT;
ALTER TABLE payments ADD COLUMN "providerStatus" TEXT;
ALTER TABLE payments ADD COLUMN "cancellationRequested" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE payments ADD COLUMN "checkoutExpiresAt" TIMESTAMP(3);
CREATE UNIQUE INDEX payments_provider_reference_key ON payments("providerReference");
CREATE UNIQUE INDEX payments_provider_transaction_key ON payments("providerTransactionId");
CREATE TABLE wompi_refund_operations (
 id UUID PRIMARY KEY, "paymentId" UUID NOT NULL REFERENCES payments(id),
 "operationKey" TEXT NOT NULL UNIQUE, amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
 status TEXT NOT NULL DEFAULT 'pending', "providerReference" TEXT UNIQUE,
 "failureReason" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" TIMESTAMP(3) NOT NULL
);
