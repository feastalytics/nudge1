import { prisma } from "@/lib/db/client";
import { MetaApiError } from "@/lib/meta/client";
import { SendDisabledError } from "./send-policy";

type LogKey = { automationId: string; commentId: string };
type Leg = "dm" | "publicReply";
export type DeliveryResult = "SENT" | "SKIPPED" | "REJECTED" | "UNKNOWN";
export const CLAIM_TIMEOUT_MS = 120_000;

export function isDefinitiveRejection(error: unknown): boolean {
  return error instanceof MetaApiError || error instanceof SendDisabledError;
}

export function canFallBackToText(error: unknown): boolean {
  // Only an explicit invalid-template rejection establishes non-delivery.
  // Network failure, timeout, malformed response and 5xx are ambiguous.
  return error instanceof MetaApiError && error.code === 100;
}

/** Claim records intent, never delivery. There is no exactly-once Meta API:
 * uncertain outcomes are quarantined for a human to reconcile. */
export async function performDelivery(
  key: LogKey,
  leg: Leg,
  send: () => Promise<string>
): Promise<DeliveryResult> {
  const claim = await prisma.dmLog.updateMany({
    where: { ...key, ...(leg === "dm" ? { dmDeliveryState: "PENDING" } : { publicReplyDeliveryState: "PENDING" }) },
    data: leg === "dm"
      ? { dmDeliveryState: "SENDING", dmClaimedAt: new Date() }
      : { publicReplyDeliveryState: "SENDING", publicReplyClaimedAt: new Date() },
  });
  if (!claim.count) return "SKIPPED";
  let messageId: string | undefined;
  try {
    messageId = await send();
    if (!messageId) throw new Error("Missing Meta message ID");
    await prisma.dmLog.update({
      where: { automationId_commentId: key },
      data: leg === "dm"
        ? { status: "SENT", dmDeliveryState: "SENT", dmSentAt: new Date(), dmMessageId: messageId, dmClaimedAt: null, errorMessage: null }
        : { publicReplyDeliveryState: "SENT", publicReplySentAt: new Date(), publicReplyMessageId: messageId, publicReplyClaimedAt: null, publicReplyError: null },
    });
    return "SENT";
  } catch (error) {
    const definitive = !messageId && isDefinitiveRejection(error);
    const state = definitive ? "REJECTED" : "UNKNOWN";
    const detail = error instanceof Error ? error.message : "Delivery failed";
    const message = definitive ? detail : `UNKNOWN: ${detail}; manually reconcile with Instagram before retrying`;
    await prisma.dmLog.update({
      where: { automationId_commentId: key },
      data: leg === "dm"
        ? { status: "FAILED", dmDeliveryState: state, dmClaimedAt: null, dmMessageId: messageId, errorMessage: message }
        : { publicReplyDeliveryState: state, publicReplyClaimedAt: null, publicReplyMessageId: messageId, publicReplyError: message },
    });
    await prisma.operationalEvent.create({ data: {
      source: "WORKER", level: "ERROR",
      message: `${leg === "dm" ? "DM" : "Public reply"} ${state}: campaign ${key.automationId}, comment ${key.commentId}. ${message}`,
      payload: { automationId: key.automationId, commentId: key.commentId, leg, deliveryState: state, messageId: messageId ?? null },
    } }).catch(() => {});
    return state;
  }
}

/** A worker may die before OR after Meta receives the request. Age cannot tell
 * which occurred: release it into UNKNOWN, never back into the send queue. */
export async function recoverInterruptedDeliveries(): Promise<void> {
  const before = new Date(Date.now() - CLAIM_TIMEOUT_MS);
  const dms = await prisma.dmLog.updateMany({
    where: { dmDeliveryState: "SENDING", dmClaimedAt: { lt: before } },
    data: { dmDeliveryState: "UNKNOWN", status: "FAILED", dmClaimedAt: null,
      errorMessage: "UNKNOWN: worker interrupted during send; manually reconcile with Instagram before retrying" },
  });
  const replies = await prisma.dmLog.updateMany({
    where: { publicReplyDeliveryState: "SENDING", publicReplyClaimedAt: { lt: before } },
    data: { publicReplyDeliveryState: "UNKNOWN", publicReplyClaimedAt: null,
      publicReplyError: "UNKNOWN: worker interrupted during public reply; manually reconcile with Instagram before retrying" },
  });
  if (dms.count || replies.count) {
    await prisma.operationalEvent.create({ data: { source: "WORKER", level: "ERROR",
      message: `UNKNOWN: ${dms.count} interrupted DMs and ${replies.count} public replies require manual reconciliation. No automatic resend.`,
    } });
  }
}
