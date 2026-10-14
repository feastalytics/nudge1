/** Poll recent campaign comments to recover missed webhooks. Public reply and
 * DM delivery are independent: an existing reply never hides a missing DM.
 * Ambiguous outcomes stay quarantined and are never retried by this sweep. */

import { prisma } from "@/lib/db/client";
import { enqueueDurably } from "@/lib/queue/outbox";
import { isOwnedInstagramAccount, isSendingEnabled, isFeastPilot } from "@/lib/queue/send-policy";
import {
  getRecentMediaComments,
  getUserMedia,
  MetaApiError,
  type InstagramComment,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { matchKeywords } from "@/lib/utils/keyword-matcher";

// Only consider comments from the last few days — older ones are outside
// Instagram's private-reply window anyway, so a DM to them would just fail.
const LOOKBACK_HOURS = boundedNumber(process.env.COMMENT_POLL_LOOKBACK_HOURS, 72, 1, 168);
// Hard cap on how many new comments a single campaign can enqueue per sweep, so
// a viral post drains gradually instead of bursting into the comment API.
const MAX_NEW_PER_SWEEP = boundedNumber(process.env.COMMENT_POLL_MAX_PER_SWEEP, 30, 1, 100);
// For "any post" campaigns, how many recent posts to scan.
const RECENT_MEDIA_LIMIT = 10;

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const number = value === undefined ? fallback : Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.floor(number))) : fallback;
}

interface SweepStat {
  campaign: string;
  keywords: string;
  matched: number;
  alreadyReplied: number;
  enqueued: number;
  errors: string[];
}

function errMessage(error: unknown): string {
  if (error instanceof MetaApiError) return `Meta ${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}

/** One reconciliation pass across every active campaign. */
export async function reconcileComments(): Promise<void> {
  if (!isSendingEnabled()) return;
  const automations = await prisma.automation.findMany({
    where: { isActive: true, ...(isFeastPilot() ? { workspaceId: "feast-internal" } : {}) },
    select: {
      id: true,
      name: true,
      postId: true,
      matchAnyPost: true,
      matchAnyWord: true,
      keywords: true,
      wholeWordMatch: true,
      publicReplyEnabled: true,
      workspaceId: true,
      instagramAccount: {
        select: {
          id: true,
          instagramId: true,
          username: true,
          accessToken: true,
        },
      },
    },
  });

  const sinceMs = Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
  const tokenCache = new Map<string, string | null>();

  for (const automation of automations) {
    if (!isOwnedInstagramAccount(automation.instagramAccount.instagramId)) continue;
    const stat = await sweepCampaign(automation, sinceMs, tokenCache).catch(
      (error): SweepStat => ({
        campaign: automation.name,
        keywords: automation.keywords.join(","),
        matched: 0,
        alreadyReplied: 0,
        enqueued: 0,
        errors: [errMessage(error)],
      })
    );
    await recordSweep(automation.workspaceId, stat);
  }
}

async function sweepCampaign(
  automation: {
    id: string;
    name: string;
    postId: string | null;
    matchAnyPost: boolean;
    matchAnyWord: boolean;
    keywords: string[];
    wholeWordMatch: boolean;
    publicReplyEnabled: boolean;
    instagramAccount: {
      id: string;
      instagramId: string;
      username: string;
      accessToken: string;
    };
  },
  sinceMs: number,
  tokenCache: Map<string, string | null>
): Promise<SweepStat> {
  const account = automation.instagramAccount;
  const stat: SweepStat = {
    campaign: automation.name,
    keywords: automation.matchAnyWord
      ? "(any word)"
      : automation.keywords.join(","),
    matched: 0,
    alreadyReplied: 0,
    enqueued: 0,
    errors: [],
  };

  // Decrypt the account token once per sweep.
  let accessToken = tokenCache.get(account.id);
  if (accessToken === undefined) {
    try {
      accessToken = decryptToken(account.accessToken);
    } catch {
      accessToken = null;
    }
    tokenCache.set(account.id, accessToken);
  }
  if (!accessToken) {
    stat.errors.push("Failed to decrypt access token");
    return stat;
  }

  // Which media this campaign covers: its own post, or the recent feed if it
  // matches any post.
  const mediaIds: string[] = [];
  if (automation.postId) {
    mediaIds.push(automation.postId);
  } else if (automation.matchAnyPost) {
    try {
      const media = await getUserMedia(accessToken, RECENT_MEDIA_LIMIT);
      mediaIds.push(...media.map((m) => m.id));
    } catch (error) {
      stat.errors.push(`Media list: ${errMessage(error)}`);
    }
  }
  if (mediaIds.length === 0) return stat;

  for (const mediaId of mediaIds) {
    if (stat.enqueued >= MAX_NEW_PER_SWEEP) break;
    let comments: InstagramComment[];
    try {
      comments = await getRecentMediaComments(accessToken, mediaId, sinceMs);
    } catch (error) {
      stat.errors.push(`Comments ${mediaId}: ${errMessage(error)}`);
      continue;
    }

    // Keep only comments that (a) aren't the account's own, (b) match the
    // keyword. Owner replies are recorded separately from DM eligibility.
    const needsAction = comments.filter((c) => {
      const authorId = c.from?.id;
      if (!authorId || authorId === account.instagramId) return false;

      const matched = automation.matchAnyWord
        ? true
        : matchKeywords(c.text ?? "", automation.keywords, automation.wholeWordMatch)
            .matched;
      if (!matched) return false;
      stat.matched += 1;

      const ownerReplied = (c.replies?.data ?? []).some(
        (r) => r.from?.id === account.instagramId
      );
      if (ownerReplied) {
        stat.alreadyReplied += 1;
      }
      return true;
    });
    if (needsAction.length === 0) continue;

    // Public replies and DMs are independent. An existing public reply must
    // not suppress a missing DM; ambiguous/rejected deliveries never retry.
    const logs = await prisma.dmLog.findMany({
      where: { automationId: automation.id, commentId: { in: needsAction.map((c) => c.id) } },
      select: { commentId: true, dmDeliveryState: true, publicReplyDeliveryState: true },
    });
    const handledSet = new Set(logs.filter((log) =>
      log.dmDeliveryState !== "PENDING" &&
      (!automation.publicReplyEnabled || log.publicReplyDeliveryState !== "PENDING")
    ).map((log) => log.commentId));

    // Oldest first, so whoever commented earliest gets answered first, capped.
    const fresh = needsAction
      .filter((c) => !handledSet.has(c.id))
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
      .slice(0, MAX_NEW_PER_SWEEP - stat.enqueued);

    for (const c of fresh) {
      // A bounded time bucket collapses concurrent sweep instances while
      // allowing a future sweep after an older completed outbox row.
      await enqueueDurably("process-comment", {
        instagramAccountId: account.instagramId,
        commentId: c.id,
        commentText: c.text ?? "",
        commenterId: c.from!.id,
        commenterName: c.from?.username,
        mediaId,
        source: "POLLING",
        ownerHasReplied: (c.replies?.data ?? []).some((r) => r.from?.id === account.instagramId),
      }, `poll:${automation.id}:${c.id}:${Math.floor(Date.now() / 300_000)}`);
      stat.enqueued += 1;
    }
  }

  return stat;
}

async function recordSweep(
  workspaceId: string,
  stat: SweepStat
): Promise<void> {
  // Only log when something happened or something went wrong.
  if (stat.enqueued === 0 && stat.errors.length === 0) return;

  await prisma.operationalEvent
    .create({
      data: {
        workspaceId,
        source: "SYSTEM",
        level: stat.errors.length > 0 ? "WARNING" : "INFO",
        message: `Comment sweep "${stat.campaign}" [${stat.keywords}]: ${stat.enqueued} enqueued, ${stat.matched} matched, ${stat.alreadyReplied} already replied`,
        payload: { ...stat },
      },
    })
    .catch(() => {});
}
