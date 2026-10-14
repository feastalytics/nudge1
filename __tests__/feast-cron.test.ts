import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  db: {
    workspace: { updateMany: vi.fn(), findMany: vi.fn() },
    instagramAccount: { findMany: vi.fn(), update: vi.fn() },
    automation: { findMany: vi.fn(), update: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  decrypt: vi.fn(), encrypt: vi.fn(), refresh: vi.fn(), media: vi.fn(), alert: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: mocks.db }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mocks.decrypt, encryptToken: mocks.encrypt }));
vi.mock("@/lib/meta/client", () => ({ refreshLongLivedToken: mocks.refresh, getUserMedia: mocks.media }));
vi.mock("@/lib/alerts", () => ({ checkAndSendAlerts: mocks.alert }));
import { GET as refreshTokens } from "@/app/api/cron/refresh-tokens/route";
import { GET as attachReel } from "@/app/api/cron/attach-next-reel/route";
import { cronAccountFilter, isAuthorizedCronRequest } from "@/lib/feast/cron";

const owned = { id: "owned", workspaceId: "feast-internal", instagramId: "123", username: "feast", accessToken: "encrypted-owned" };
const outside = { ...owned, id: "outside", workspaceId: "other", accessToken: "encrypted-outside" };
const unlisted = { ...owned, id: "unlisted", instagramId: "999", accessToken: "encrypted-unlisted" };
function request(bearer = "Bearer cron-secret") {
  return new NextRequest("https://nudge.example/api/cron/test", { headers: { authorization: bearer } });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FEAST_MODE", "true"); vi.stubEnv("FEAST_SSO_SECRET", "a".repeat(32));
  vi.stubEnv("FEAST_ADMIN_ORIGIN", "https://admin.example"); vi.stubEnv("NEXTAUTH_URL", "https://nudge.example");
  vi.stubEnv("FEAST_SOURCE_URL", "https://github.com/feast/nudge/tree/abc");
  vi.stubEnv("FEAST_OWNED_INSTAGRAM_IDS", "123"); vi.stubEnv("CRON_SECRET", "cron-secret"); vi.stubEnv("NEXTAUTH_SECRET", undefined);
  mocks.db.workspace.updateMany.mockResolvedValue({ count: 1 }); mocks.db.workspace.findMany.mockResolvedValue([]);
  mocks.db.instagramAccount.findMany.mockResolvedValue([owned]); mocks.db.instagramAccount.update.mockResolvedValue({});
  mocks.db.automation.findMany.mockResolvedValue([]); mocks.db.automation.update.mockResolvedValue({});
  mocks.decrypt.mockImplementation((token) => `plain-${token}`); mocks.encrypt.mockReturnValue("new-encrypted");
  mocks.refresh.mockResolvedValue({ accessToken: "new-token", expiresIn: 86400 }); mocks.media.mockResolvedValue([]);
});
afterEach(() => vi.unstubAllEnvs());

describe("cron authentication", () => {
  it.each([refreshTokens, attachReel])("rejects Bearer undefined when no secret is configured", async (handler) => {
    vi.stubEnv("CRON_SECRET", undefined); vi.stubEnv("NEXTAUTH_SECRET", undefined);
    expect((await handler(request("Bearer undefined"))).status).toBe(401);
    expect(mocks.db.workspace.updateMany).not.toHaveBeenCalled(); expect(mocks.db.automation.findMany).not.toHaveBeenCalled();
  });
  it("rejects blank, incorrect and missing credentials but retains configured legacy fallback", () => {
    expect(isAuthorizedCronRequest(request("Bearer wrong"))).toBe(false);
    expect(isAuthorizedCronRequest(new Request("https://nudge.example"))).toBe(false);
    vi.stubEnv("CRON_SECRET", " "); expect(isAuthorizedCronRequest(request("Bearer  "))).toBe(false);
    vi.stubEnv("CRON_SECRET", undefined); vi.stubEnv("NEXTAUTH_SECRET", "legacy-secret");
    expect(isAuthorizedCronRequest(request("Bearer legacy-secret"))).toBe(true);
  });
  it("fails closed when pilot configuration is incomplete", () => {
    vi.stubEnv("FEAST_SSO_SECRET", undefined);
    expect(isAuthorizedCronRequest(request())).toBe(false);
  });
});

describe("pilot cron account boundaries", () => {
  it("refreshes only allowed internal accounts and resets only internal usage", async () => {
    mocks.db.instagramAccount.findMany.mockResolvedValue([owned, outside, unlisted]);
    expect((await refreshTokens(request())).status).toBe(200);
    expect(mocks.db.instagramAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "feast-internal", instagramId: { in: ["123"] } }) }));
    expect(mocks.db.workspace.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "feast-internal" }) }));
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("plain-encrypted-owned");
    expect(mocks.db.instagramAccount.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "owned" } }));
    expect(mocks.alert).not.toHaveBeenCalled();
  });
  it("does not poll foreign accounts or foreign campaigns", async () => {
    const campaign = { id: "campaign", workspaceId: "feast-internal", instagramAccountId: "owned", instagramAccount: owned, createdAt: new Date("2026-10-01") };
    mocks.db.automation.findMany.mockResolvedValue([campaign, { ...campaign, id: "outside", instagramAccount: outside }, { ...campaign, id: "unlisted", instagramAccount: unlisted }, { ...campaign, id: "foreign", workspaceId: "other" }]);
    mocks.media.mockResolvedValue([{ id: "reel", timestamp: "2026-10-14", media_product_type: "REELS" }]);
    expect((await attachReel(request())).status).toBe(200);
    expect(mocks.media).toHaveBeenCalledExactlyOnceWith("plain-encrypted-owned", 25);
    expect(mocks.db.automation.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "campaign" } }));
    expect(mocks.db.automation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ workspaceId: "feast-internal", instagramAccount: { workspaceId: "feast-internal", instagramId: { in: ["123"] } } }) }));
  });
  it("empty allowlist cannot refresh any account", async () => {
    vi.stubEnv("FEAST_OWNED_INSTAGRAM_IDS", "");
    expect(cronAccountFilter()).toEqual({ workspaceId: "feast-internal", instagramId: { in: [] } });
    await refreshTokens(request());
    expect(mocks.decrypt).not.toHaveBeenCalled(); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("keeps nonpilot refresh and alert behavior", async () => {
    vi.stubEnv("FEAST_MODE", "false"); vi.stubEnv("FEAST_SSO_SECRET", undefined);
    mocks.db.instagramAccount.findMany.mockResolvedValue([outside, unlisted]);
    mocks.db.workspace.findMany.mockResolvedValue([{ id: "other" }]);
    await refreshTokens(request());
    expect(cronAccountFilter()).toEqual({});
    expect(mocks.refresh).toHaveBeenCalledTimes(2); expect(mocks.alert).toHaveBeenCalledWith("other");
  });
});
