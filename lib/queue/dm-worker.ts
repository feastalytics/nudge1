import { Worker, type Job } from "bullmq";
import { getRedisConnection, POSTBACK_JOB_NAME, type DmQueueJob, type ProcessCommentJob, type ProcessPostbackJob } from "./client";
import { prisma } from "@/lib/db/client";
import {
  MetaApiError, sendCommentReply, sendDirectMessage, sendDirectMessageWithButton,
  sendDirectMessageWithLinkButton, sendPrivateReply, sendPrivateReplyWithButton,
  sendPrivateReplyWithLinkButton,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { reserveDMSlot } from "@/lib/utils/rate-limiter";
import { releaseWorkspaceDMReservation, reserveWorkspaceDMSend } from "@/lib/billing/usage";
import { recordWorkerActivity, recordWorkerAlert } from "@/lib/ops/worker-health";
import { buildTrackedUrl, renderMessageWithTracking, renderMessageWithoutLink } from "@/lib/tracking/message";
import { canFallBackToText, performDelivery } from "./delivery";
import { assertSendAllowed, isOwnedInstagramAccount, isFeastPilot } from "./send-policy";
import { enqueueDurably } from "./outbox";

const BACKOFF_DELAYS = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000];
function formatError(error: unknown): string {
  if (error instanceof MetaApiError) return `Meta API Error ${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : "Unknown error";
}

async function processComment(job: Job<ProcessCommentJob>): Promise<void> {
  const { instagramAccountId, commentId, commentText, commenterId, commenterName, mediaId } = job.data;
  const automations = await prisma.automation.findMany({
    where: { ...(isFeastPilot() ? { workspaceId: "feast-internal" } : {}), OR: [{ postId: mediaId }, { matchAnyPost: true }], isActive: true, instagramAccount: { instagramId: instagramAccountId } },
    include: { instagramAccount: true, workspace: true, trackedLinks: { select: { slug: true, destinationUrl: true }, orderBy: { createdAt: "asc" } } },
    orderBy: { createdAt: "asc" },
  });
  for (const automation of automations) {
    const match = automation.matchAnyWord ? { matched: true, matchedKeyword: null } : matchKeywords(commentText, automation.keywords, automation.wholeWordMatch);
    if (!match.matched) continue;
    const key = { automationId: automation.id, commentId };
    // Upsert does not reset delivery state. A retried or concurrent job must
    // observe the previous attempt, especially UNKNOWN and SENDING claims.
    const log = await prisma.dmLog.upsert({
      where: { automationId_commentId: key },
      create: { workspaceId: automation.workspaceId, ...key, instagramAccountId: automation.instagramAccountId,
        commenterId, commenterName, commentText, matchedKeyword: match.matchedKeyword,
        status: "PENDING", attempts: job.attemptsMade + 1 },
      update: {},
    });
    if (log.dmDeliveryState !== "PENDING" && (!automation.publicReplyEnabled || log.publicReplyDeliveryState !== "PENDING")) continue;
    let accessToken: string;
    try {
      if (!automation.instagramAccount.accessToken) throw new Error("No Instagram access token available");
      accessToken = decryptToken(automation.instagramAccount.accessToken);
    } catch (error) {
      await prisma.dmLog.update({ where: { automationId_commentId: key }, data: { status: "FAILED", errorMessage: formatError(error) } });
      continue;
    }
    const replies = automation.publicReplyMessages.length ? automation.publicReplyMessages : automation.publicReplyMessage ? [automation.publicReplyMessage] : [];
    if (job.data.ownerHasReplied) {
      await prisma.dmLog.updateMany({ where: { ...key, publicReplyDeliveryState: "PENDING" },
        data: { publicReplyDeliveryState: "REJECTED", publicReplyError: "Skipped: account already replied on Instagram" } });
    }
    if (automation.publicReplyEnabled && replies.length && !job.data.ownerHasReplied) {
      await performDelivery(key, "publicReply", async () => {
        assertSendAllowed(instagramAccountId);
        const message = renderMessageWithTracking({ message: replies[Math.floor(Math.random() * replies.length)], commenterName, trackedLinks: automation.trackedLinks });
        return (await sendCommentReply(accessToken, commentId, message, instagramAccountId)).id;
      });
    }
    if (log.dmDeliveryState !== "PENDING") continue;

    const usage = await reserveWorkspaceDMSend(automation.workspaceId);
    let retainUsage = false;
    try {
      const rateLimit = await reserveDMSlot(instagramAccountId, job.data.requeueAttempt ?? 0);
      if (!rateLimit.allowed) {
        await prisma.dmLog.update({ where: { automationId_commentId: key }, data: {
          status: rateLimit.shouldSkip ? "SKIPPED_RATE_LIMIT" : "PENDING",
          errorMessage: rateLimit.shouldSkip ? "Hourly Instagram DM rate limit reached" : "Hourly rate limit hit; retry scheduled",
        } });
        if (rateLimit.shouldRequeue) {
          const attempt = (job.data.requeueAttempt ?? 0) + 1;
          const { outboxId: _outboxId, ...data } = job.data;
          await enqueueDurably("process-comment", { ...data, requeueAttempt: attempt },
            `comment:${instagramAccountId}:${commentId}:retry:${attempt}`, rateLimit.requeueDelayMs);
        }
        continue;
      }
      retainUsage = true; // A failed result write can follow an accepted send.
      const result = await performDelivery(key, "dm", async () => {
        assertSendAllowed(instagramAccountId);
        const opening = automation.openingDmEnabled && automation.openingDmMessage && automation.openingDmButtonLabel;
        if (opening) {
          const useFollow = automation.followStepEnabled && automation.followStepMessage && automation.followStepButtonLabel;
          const text = renderMessageWithTracking({ message: automation.openingDmMessage!, commenterName, trackedLinks: [] });
          return (await sendPrivateReplyWithButton(accessToken, instagramAccountId, commentId, text,
            automation.openingDmButtonLabel!, `${useFollow ? "follow" : "reveal"}:${automation.id}`)).message_id;
        }
        const link = automation.trackedLinks[0];
        if (link) {
          const text = renderMessageWithoutLink({ message: automation.dmMessage, commenterName }) || "Here's your link:";
          const url = buildTrackedUrl(link.slug);
          try {
            return (await sendPrivateReplyWithLinkButton(accessToken, instagramAccountId, commentId, text,
              automation.linkButtonLabel || "Open link", url)).message_id;
          } catch (error) {
            if (!canFallBackToText(error)) throw error;
            const fallback = renderMessageWithTracking({ message: automation.dmMessage, commenterName, trackedLinks: [link] }) || `${text}\n${url}`;
            return (await sendPrivateReply(accessToken, instagramAccountId, commentId, fallback)).message_id;
          }
        }
        const text = renderMessageWithTracking({ message: automation.dmMessage, commenterName, trackedLinks: automation.trackedLinks });
        return (await sendPrivateReply(accessToken, instagramAccountId, commentId, text)).message_id;
      });
      // Unknown sends may have been delivered. Keep usage reserved until a
      // human reconciles; never undercount uncertain delivery as a safe retry.
      retainUsage = result === "SENT" || result === "UNKNOWN";
    } finally {
      if (!retainUsage) await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
    }
  }
}

async function processPostback(job: Job<ProcessPostbackJob>): Promise<void> {
  const { instagramAccountId, userId, payload } = job.data;
  const stage = payload.startsWith("follow:") ? "follow" : payload.startsWith("reveal:") ? "reveal" : null;
  if (!stage) return;
  const automation = await prisma.automation.findFirst({
    where: { ...(isFeastPilot() ? { workspaceId: "feast-internal" } : {}), id: payload.slice(stage.length + 1), isActive: true, instagramAccount: { instagramId: instagramAccountId } },
    include: { instagramAccount: true, trackedLinks: { select: { slug: true, destinationUrl: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!automation?.instagramAccount.accessToken) return;
  if (stage === "follow" && !(automation.followStepEnabled && automation.followStepMessage && automation.followStepButtonLabel)) return;
  const opening = await prisma.dmLog.findFirst({ where: { automationId: automation.id, commenterId: userId }, select: { commenterName: true } });
  const commenterName = opening?.commenterName;
  // One delivery per campaign/person/stage, including across repeated button
  // taps and webhook redelivery. A new campaign starts a new conversation flow.
  const key = { automationId: automation.id, commentId: `${stage}:${userId}` };
  const log = await prisma.dmLog.upsert({
    where: { automationId_commentId: key },
    create: { ...key, workspaceId: automation.workspaceId, instagramAccountId: automation.instagramAccountId,
      commenterId: userId, commenterName, commentText: "(button tap)", status: "PENDING" }, update: {},
  });
  if (log.dmDeliveryState !== "PENDING") return;
  const accessToken = decryptToken(automation.instagramAccount.accessToken);
  const usage = await reserveWorkspaceDMSend(automation.workspaceId);
  let retainUsage = false;
  try {
    const rateLimit = await reserveDMSlot(instagramAccountId);
    if (!rateLimit.allowed) throw new Error("Instagram DM rate limit reached; postback queued for retry");
    retainUsage = true; // Keep uncertain sends counted if persistence fails.
    const result = await performDelivery(key, "dm", async () => {
      assertSendAllowed(instagramAccountId);
      if (stage === "follow") {
        const text = renderMessageWithTracking({ message: automation.followStepMessage!, commenterName, trackedLinks: [] });
        return (await sendDirectMessageWithButton(accessToken, instagramAccountId, userId, text,
          automation.followStepButtonLabel!, `reveal:${automation.id}`)).message_id;
      }
      const link = automation.trackedLinks[0];
      if (link) {
        const text = renderMessageWithoutLink({ message: automation.dmMessage, commenterName }) || "Here's your link:";
        const url = buildTrackedUrl(link.slug);
        try {
          return (await sendDirectMessageWithLinkButton(accessToken, instagramAccountId, userId, text, automation.linkButtonLabel || "Open link", url)).message_id;
        } catch (error) {
          if (!canFallBackToText(error)) throw error;
          const fallback = renderMessageWithTracking({ message: automation.dmMessage, commenterName, trackedLinks: [link] }) || `${text}\n${url}`;
          return (await sendDirectMessage(accessToken, instagramAccountId, userId, fallback)).message_id;
        }
      }
      const text = renderMessageWithTracking({ message: automation.dmMessage, commenterName, trackedLinks: automation.trackedLinks });
      return (await sendDirectMessage(accessToken, instagramAccountId, userId, text)).message_id;
    });
    retainUsage = result === "SENT" || result === "UNKNOWN";
  } finally {
    if (!retainUsage) await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
  }
}

async function processJob(job: Job<DmQueueJob>): Promise<void> {
  if (isOwnedInstagramAccount(job.data.instagramAccountId)) {
    assertSendAllowed(job.data.instagramAccountId);
    if (job.name === POSTBACK_JOB_NAME) await processPostback(job as Job<ProcessPostbackJob>);
    else await processComment(job as Job<ProcessCommentJob>);
  }
  if (job.data.outboxId) {
    await prisma.queueOutbox.update({ where: { id: job.data.outboxId }, data: { completedAt: new Date() } });
  }
}

async function recordWorkerFailure(
  job: Job<DmQueueJob> | undefined,
  error: Error
) {
  try {
    const instagramAccountId = job?.data.instagramAccountId;
    const commentId =
      job && "commentId" in job.data ? job.data.commentId : null;
    const account = instagramAccountId
      ? await prisma.instagramAccount.findUnique({
          where: { instagramId: instagramAccountId },
          select: { workspaceId: true },
        })
      : null;

    await prisma.operationalEvent.create({
      data: {
        workspaceId: account?.workspaceId ?? null,
        source: "WORKER",
        level: "ERROR",
        message: `DM worker job ${job?.id ?? "unknown"} failed: ${error.message}`,
        payload: {
          jobId: job?.id ?? null,
          attemptsMade: job?.attemptsMade ?? null,
          instagramAccountId: instagramAccountId ?? null,
          commentId,
        },
      },
    });

    await recordWorkerAlert({
      level: "error",
      message: error.message,
      jobId: job?.id,
      instagramAccountId,
      commentId: commentId ?? undefined,
    });
  } catch (recordError) {
    console.error(
      "[DM Worker] Failed to record worker failure:",
      formatError(recordError)
    );
  }
}

export function createDMWorker(): Worker<DmQueueJob> {
  const worker = new Worker<DmQueueJob>(
    "dm-processing",
    processJob,
    {
      connection: getRedisConnection(),
      concurrency: 2,
      drainDelay: 30,
      stalledInterval: 30_000,
      maxStalledCount: 1,
      settings: {
        backoffStrategy: (attemptsMade: number) =>
          BACKOFF_DELAYS[Math.min(attemptsMade - 1, BACKOFF_DELAYS.length - 1)],
      },
    }
  );

  worker.on("active", () => {
    void recordWorkerActivity();
  });

  worker.on("completed", (job) => {
    console.log(`[DM Worker] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[DM Worker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message
    );
    void recordWorkerFailure(job, err);
  });

  worker.on("error", (err) => {
    console.error("[DM Worker] Worker error:", err.message);
    void prisma.operationalEvent
      .create({
        data: {
          source: "WORKER",
          level: "ERROR",
          message: `DM worker process error: ${err.message}`,
          payload: { name: err.name },
        },
      })
      .catch((recordError) => {
        console.error(
          "[DM Worker] Failed to record worker process error:",
          formatError(recordError)
        );
      });
  });

  return worker;
}

