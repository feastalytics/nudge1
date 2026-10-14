import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ operationalEvent: { create: vi.fn() }, dmLog: { updateMany: vi.fn(), update: vi.fn() } }));
vi.mock("@/lib/db/client", () => ({ prisma: db }));
import { performDelivery, recoverInterruptedDeliveries, canFallBackToText, CLAIM_TIMEOUT_MS } from "@/lib/queue/delivery";
import { MetaApiError, sendPrivateReply, subscribeInstagramAccountToWebhooks } from "@/lib/meta/client";
import { assertSendAllowed, isOwnedInstagramAccount, isSendingEnabled } from "@/lib/queue/send-policy";

const key = { automationId: "campaign", commentId: "comment" };
beforeEach(() => {
  vi.clearAllMocks();
  db.dmLog.updateMany.mockResolvedValue({ count: 1 });
  db.dmLog.update.mockResolvedValue({});
  db.operationalEvent.create.mockResolvedValue({});
  vi.stubEnv("FEAST_SSO_SECRET", "test-feast-secret");
  vi.stubEnv("FEAST_OWNED_INSTAGRAM_IDS", "123,456");
  vi.stubEnv("FEAST_SEND_ENABLED", "true");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("durable delivery safety", () => {
  it("does not mark a claim as sent and persists the actual Meta ID on success", async () => {
    const result = await performDelivery(key, "dm", async () => "meta-message-1");
    expect(result).toBe("SENT");
    const claim = db.dmLog.updateMany.mock.calls[0][0];
    expect(claim.data).not.toHaveProperty("dmSentAt");
    expect(claim.where.dmDeliveryState).toBe("PENDING");
    expect(db.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dmMessageId: "meta-message-1", dmDeliveryState: "SENT", dmSentAt: expect.any(Date) }) }));
  });

  it("lets exactly one concurrent claim call Meta", async () => {
    let claimed = false;
    db.dmLog.updateMany.mockImplementation(async () => ({ count: claimed ? 0 : (claimed = true, 1) }));
    const send = vi.fn().mockResolvedValue("id");
    await Promise.all([performDelivery(key, "dm", send), performDelivery(key, "dm", send)]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("quarantines network ambiguity without releasing the claim to retry", async () => {
    expect(await performDelivery(key, "dm", async () => { throw new Error("connection reset"); })).toBe("UNKNOWN");
    expect(db.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", dmDeliveryState: "UNKNOWN", errorMessage: expect.stringContaining("manually reconcile") }) }));
  });

  it("retains a known Meta ID if the success DB write fails", async () => {
    db.dmLog.update.mockRejectedValueOnce(new Error("DB unavailable")).mockResolvedValueOnce({});
    expect(await performDelivery(key, "dm", async () => "accepted-id")).toBe("UNKNOWN");
    expect(db.dmLog.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ dmMessageId: "accepted-id", dmDeliveryState: "UNKNOWN" }) }));
  });

  it("treats explicit rejection differently from an uncertain response", async () => {
    const rejection = new MetaApiError(100, undefined, undefined, "Invalid template");
    expect(canFallBackToText(rejection)).toBe(true);
    expect(canFallBackToText(new Error("timeout"))).toBe(false);
    expect(await performDelivery(key, "dm", async () => { throw rejection; })).toBe("REJECTED");
  });

  it("recovery makes interrupted DM and public claims UNKNOWN, never SENT or PENDING", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-14T15:00:00Z"));
    await recoverInterruptedDeliveries();
    expect(db.dmLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { dmDeliveryState: "SENDING", dmClaimedAt: { lt: new Date(Date.now() - CLAIM_TIMEOUT_MS) } }, data: expect.objectContaining({ dmDeliveryState: "UNKNOWN", status: "FAILED" }) }));
    expect(db.dmLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ publicReplyDeliveryState: "UNKNOWN" }) }));
  });

  it("records a public reply ID only after confirmed acceptance", async () => {
    await performDelivery(key, "publicReply", async () => "reply-id");
    expect(db.dmLog.updateMany.mock.calls[0][0].data).not.toHaveProperty("publicReplySentAt");
    expect(db.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ publicReplyDeliveryState: "SENT", publicReplyMessageId: "reply-id" }) }));
  });
});

describe("Feast send boundary", () => {
  it("defaults to disabled and missing allowlist denies every account", () => {
    vi.stubEnv("FEAST_SEND_ENABLED", "");
    expect(isSendingEnabled()).toBe(false);
    expect(() => assertSendAllowed("123")).toThrow();
    vi.stubEnv("FEAST_SEND_ENABLED", "true"); vi.stubEnv("FEAST_OWNED_INSTAGRAM_IDS", "");
    expect(isOwnedInstagramAccount("123")).toBe(false);
    expect(() => assertSendAllowed("123")).toThrow();
  });

  it("blocks direct client sends for a non-Feast account before fetch", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(sendPrivateReply("fake-token", "789", "comment", "hello")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects 5xx and successful responses missing an ID as ambiguous", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response('{"error":{"code":100}}', { status: 500 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 })));
    await expect(sendPrivateReply("fake-token", "123", "comment", "hello")).rejects.toThrow("UNKNOWN");
    await expect(sendPrivateReply("fake-token", "123", "comment", "hello")).rejects.toThrow("UNKNOWN");
  });

  it("subscribes to postback callbacks required by the opening DM flow", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"success":true}', { status: 200 })); vi.stubGlobal("fetch", fetch);
    await subscribeInstagramAccountToWebhooks("123", "fake-token");
    expect(JSON.parse(fetch.mock.calls[0][1].body).subscribed_fields).toContain("messaging_postbacks");
  });
});
