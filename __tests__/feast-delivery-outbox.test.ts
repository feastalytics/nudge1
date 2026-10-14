import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";

const state = vi.hoisted(() => {
  const db = {
    webhookEvent: { upsert: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    queueOutbox: { upsert: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(),
  };
  return { db, add: vi.fn(), getJob: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ prisma: state.db }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => ({ add: state.add, getJob: state.getJob }), POSTBACK_JOB_NAME: "process-postback" }));
import { POST } from "@/app/api/webhook/route";
import { dispatchOutbox, replayWebhookReceipts } from "@/lib/queue/outbox";

const payload = { object: "instagram", entry: [{ id: "123", time: 1, messaging: [{ sender: { id: "user" }, postback: { mid: "mid", payload: "reveal:campaign" } }] }] };
function request(body = JSON.stringify(payload), signature?: string) {
  return new NextRequest("https://nudge.example/api/webhook", { method: "POST", body,
    headers: { "x-hub-signature-256": signature ?? "sha256=" + createHmac("sha256", "test-webhook-secret").update(body).digest("hex") } });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FACEBOOK_APP_SECRET", "test-webhook-secret"); vi.stubEnv("INSTAGRAM_APP_SECRET", "");
  vi.stubEnv("FEAST_MODE", "true"); vi.stubEnv("FEAST_OWNED_INSTAGRAM_IDS", "123"); vi.stubEnv("FEAST_SEND_ENABLED", "true");
  state.db.webhookEvent.upsert.mockResolvedValue({ id: "receipt" });
  state.db.webhookEvent.update.mockResolvedValue({});
  state.db.webhookEvent.findMany.mockResolvedValue([{ id: "receipt", payload, replayAttempts: 0 }]);
  state.db.queueOutbox.upsert.mockResolvedValue({});
  state.db.queueOutbox.update.mockResolvedValue({});
  state.db.$transaction.mockImplementation(async (callback) => callback(state.db));
  state.add.mockResolvedValue({});
  state.getJob.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("durable webhook acceptance", () => {
  it("acknowledges only after durable storage and never depends on Redis", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(state.db.webhookEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ status: "PENDING", payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/) }), update: {} }));
    expect(state.add).not.toHaveBeenCalled();
  });
  it("returns 503 so Meta redelivers when persistence fails", async () => {
    state.db.webhookEvent.upsert.mockRejectedValue(new Error("database down"));
    expect((await POST(request())).status).toBe(503);
  });
  it("rejects bad signatures and oversize bodies before database writes", async () => {
    expect((await POST(request(undefined, "bad"))).status).toBe(401);
    expect((await POST(request("a".repeat(1024 * 1024 + 1)))).status).toBe(413);
    expect(state.db.webhookEvent.upsert).not.toHaveBeenCalled();
  });
  it("replays a postback independently of comment polling in one transaction", async () => {
    await replayWebhookReceipts();
    expect(state.db.$transaction).toHaveBeenCalledTimes(1);
    expect(state.db.queueOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ jobName: "process-postback", payload: expect.objectContaining({ mid: "mid", payload: "reveal:campaign" }) }) }));
    expect(state.db.webhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PROCESSED" }) }));
  });
  it("leaves a replayable failed receipt when outbox insertion fails", async () => {
    state.db.queueOutbox.upsert.mockRejectedValue(new Error("transaction failed"));
    await replayWebhookReceipts();
    expect(state.db.webhookEvent.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", replayAfter: expect.any(Date) }) }));
    expect(state.db.webhookEvent.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "PROCESSED" }) }));
  });
  it("filters unowned accounts before creating outbound work", async () => {
    vi.stubEnv("FEAST_OWNED_INSTAGRAM_IDS", "999");
    await replayWebhookReceipts();
    expect(state.db.queueOutbox.upsert).not.toHaveBeenCalled();
  });
});

describe("durable dispatch recovery", () => {
  it("does not complete durable work merely because Redis accepted it", async () => {
    state.db.queueOutbox.findMany.mockResolvedValue([{ id: "outbox-id", jobName: "process-postback", payload: { instagramAccountId: "123", userId: "user", payload: "reveal:campaign" } }]);
    await dispatchOutbox();
    expect(state.add).toHaveBeenCalledWith("process-postback", expect.objectContaining({ outboxId: "outbox-id" }), { jobId: "outbox-id" });
    expect(state.db.queueOutbox.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ completedAt: expect.any(Date) }) }));
  });
  it("removes an exhausted Redis job so a durable unfinished row is recoverable", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    state.getJob.mockResolvedValue({ getState: async () => "failed", remove });
    state.db.queueOutbox.findMany.mockResolvedValue([{ id: "outbox-id", jobName: "process-postback", payload: { instagramAccountId: "123", userId: "user", payload: "reveal:campaign" } }]);
    await dispatchOutbox();
    expect(remove).toHaveBeenCalledTimes(1); expect(state.add).toHaveBeenCalledTimes(1);
  });
  it("pauses dispatch while the send switch is off", async () => {
    vi.stubEnv("FEAST_SEND_ENABLED", "false");
    await dispatchOutbox();
    expect(state.db.queueOutbox.findMany).not.toHaveBeenCalled(); expect(state.add).not.toHaveBeenCalled();
  });
});
