CREATE TYPE "DeliveryState" AS ENUM ('PENDING', 'SENDING', 'SENT', 'REJECTED', 'UNKNOWN');
ALTER TABLE "DmLog"
 ADD COLUMN "dmDeliveryState" "DeliveryState" NOT NULL DEFAULT 'PENDING',
 ADD COLUMN "dmClaimedAt" TIMESTAMP(3),
 ADD COLUMN "dmMessageId" TEXT,
 ADD COLUMN "publicReplyDeliveryState" "DeliveryState" NOT NULL DEFAULT 'PENDING',
 ADD COLUMN "publicReplyClaimedAt" TIMESTAMP(3),
 ADD COLUMN "publicReplyMessageId" TEXT;
-- Legacy timestamps were also used as pre-send claims. Only a SENT DM is
-- confirmed. Public reply timestamps cannot be proven; quarantine for review.
UPDATE "DmLog" SET "dmDeliveryState" = 'SENT' WHERE "status" = 'SENT';
UPDATE "DmLog" SET "dmDeliveryState" = 'UNKNOWN', "status" = 'FAILED', "dmSentAt" = NULL,
 "errorMessage" = 'UNKNOWN: legacy interrupted send; manually reconcile before retrying'
 WHERE "dmSentAt" IS NOT NULL AND "status" <> 'SENT';
UPDATE "DmLog" SET "publicReplyDeliveryState" = 'UNKNOWN', "publicReplySentAt" = NULL,
 "publicReplyError" = 'UNKNOWN: legacy public reply claim; manually reconcile before retrying'
 WHERE "publicReplySentAt" IS NOT NULL;
ALTER TABLE "WebhookEvent" ADD COLUMN "payloadHash" TEXT,
 ADD COLUMN "replayAttempts" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "replayAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "WebhookEvent_payloadHash_key" ON "WebhookEvent"("payloadHash");
CREATE TABLE "QueueOutbox" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "jobName" TEXT NOT NULL,
 "payload" JSONB NOT NULL,
 "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "nextDispatchAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "completedAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "QueueOutbox_completedAt_nextDispatchAt_idx" ON "QueueOutbox"("completedAt", "nextDispatchAt");
