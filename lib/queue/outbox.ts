import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { Prisma } from "@/app/generated/prisma/client";
import { parseCommentEvents, parsePostbackEvents } from "@/lib/meta/webhook";
import { getDMQueue, POSTBACK_JOB_NAME, type DmQueueJob } from "./client";
import { isOwnedInstagramAccount, isSendingEnabled } from "./send-policy";

function eventId(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export async function enqueueDurably(
  jobName: string,
  payload: DmQueueJob,
  key: string,
  delayMs = 0,
  db: Pick<Prisma.TransactionClient, "queueOutbox"> = prisma
): Promise<void> {
  const availableAt = new Date(Date.now() + delayMs);
  await db.queueOutbox.upsert({
    where: { id: eventId(key) },
    create: {
      id: eventId(key), jobName,
      payload: payload as unknown as Prisma.InputJsonValue,
      availableAt, nextDispatchAt: availableAt,
    },
    update: {},
  });
}

/** Receipt -> outbox is atomic. A crash at any point is safe to replay. */
export async function replayWebhookReceipts(): Promise<void> {
  const receipts = await prisma.webhookEvent.findMany({
    where: { status: { in: ["PENDING", "FAILED"] }, replayAfter: { lte: new Date() } },
    orderBy: { createdAt: "asc" }, take: 25,
  });
  for (const receipt of receipts) {
    try {
      const comments = parseCommentEvents(receipt.payload as unknown as Parameters<typeof parseCommentEvents>[0]);
      const postbacks = parsePostbackEvents(receipt.payload as unknown as Parameters<typeof parsePostbackEvents>[0]);
      await prisma.$transaction(async (tx) => {
        for (const event of comments) {
          if (!isOwnedInstagramAccount(event.instagramAccountId)) continue;
          await enqueueDurably("process-comment", { ...event, source: "WEBHOOK" },
            `comment:${event.instagramAccountId}:${event.commentId}`, 0, tx);
        }
        for (const event of postbacks) {
          if (!isOwnedInstagramAccount(event.instagramAccountId)) continue;
          await enqueueDurably(POSTBACK_JOB_NAME, event,
            `postback:${event.instagramAccountId}:${event.userId}:${event.mid ?? event.payload}`, 0, tx);
        }
        await tx.webhookEvent.update({
          where: { id: receipt.id },
          data: { status: "PROCESSED", processedAt: new Date(), errorMessage: null },
        });
      });
    } catch {
      await prisma.webhookEvent.update({
        where: { id: receipt.id },
        data: {
          status: "FAILED", errorMessage: "Receipt replay failed; automatic retry scheduled",
          replayAttempts: { increment: 1 },
          replayAfter: new Date(Date.now() + Math.min(3600_000, 15_000 * 2 ** Math.min(receipt.replayAttempts, 8))),
        },
      });
    }
  }
}

/** Unfinished rows stay in Postgres until processing acknowledges completion.
 * Re-dispatch recovers even when Redis is flushed or loses a queued message. */
export async function dispatchOutbox(): Promise<void> {
  if (!isSendingEnabled()) return;
  const rows = await prisma.queueOutbox.findMany({
    where: { completedAt: null, nextDispatchAt: { lte: new Date() }, availableAt: { lte: new Date() } },
    orderBy: { nextDispatchAt: "asc" }, take: 50,
  });
  const queue = getDMQueue();
  for (const row of rows) {
    const payload = row.payload as unknown as DmQueueJob;
    if (!isOwnedInstagramAccount(payload.instagramAccountId)) {
      await prisma.queueOutbox.update({ where: { id: row.id }, data: { completedAt: new Date() } });
      continue;
    }
    // Advance before Redis: if enqueue fails, retry in a bounded 30 seconds.
    // Deterministic id collapses concurrent dispatchers; delivery claims are
    // the ultimate duplicate guard if Redis state is lost.
    await prisma.queueOutbox.update({ where: { id: row.id }, data: { nextDispatchAt: new Date(Date.now() + 30_000) } });
    const existing = await queue.getJob(row.id);
    if (existing && (await existing.getState()) === "failed") {
      // BullMQ age-based cleanup is lazy and may never run on an idle queue.
      // This row is still unfinished, so explicitly release its exhausted id.
      await existing.remove();
    }
    await queue.add(row.jobName, { ...payload, outboxId: row.id }, { jobId: row.id });
  }
}
