ALTER TYPE "CertificationStatus" ADD VALUE IF NOT EXISTS 'expired';
CREATE TYPE "CertificationVerificationStatus" AS ENUM ('pending', 'approved', 'rejected');
ALTER TABLE "certificaciones"
  ADD COLUMN "file_name" VARCHAR(255),
  ADD COLUMN "mime_type" VARCHAR(100),
  ADD COLUMN "storage_key" VARCHAR(255),
  ADD COLUMN "file_size" INTEGER,
  ADD COLUMN "verification_status" "CertificationVerificationStatus" NOT NULL DEFAULT 'pending',
  ADD COLUMN "verification_notes" TEXT,
  ADD COLUMN "verified_by" UUID,
  ADD COLUMN "verified_at" TIMESTAMPTZ(6);
CREATE INDEX "certificaciones_verification_status_idx" ON "certificaciones"("verification_status");
