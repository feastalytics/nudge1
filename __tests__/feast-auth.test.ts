import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const prisma = {
    user: { upsert: vi.fn() },
    workspace: { upsert: vi.fn() },
    workspaceMember: { upsert: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    session: { create: vi.fn() },
    instagramAccount: { upsert: vi.fn() },
    $transaction: vi.fn(),
  };
  return {
    prisma,
    redis: { connect: vi.fn(), set: vi.fn(), disconnect: vi.fn(), on: vi.fn() },
    rawAuth: vi.fn(), rawSignIn: vi.fn(), rawHandler: vi.fn(), nextAuth: vi.fn(),
    authConfiguration: { current: undefined as undefined | (() => Record<string, unknown>) },
    exchange: vi.fn(), longLived: vi.fn(), userInfo: vi.fn(), subscribe: vi.fn(),
    canConnect: vi.fn(), verifyState: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ prisma: mocks.prisma }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }));
vi.mock("next-auth", () => ({
  default: mocks.nextAuth.mockImplementation((configuration) => {
    mocks.authConfiguration.current = configuration;
    return {
    auth: mocks.rawAuth,
    signIn: mocks.rawSignIn,
    signOut: vi.fn(),
    handlers: { GET: mocks.rawHandler, POST: mocks.rawHandler },
    };
  }),
}));
vi.mock("ioredis", () => ({ default: class { constructor() { return mocks.redis; } } }));
vi.mock("@/lib/meta/client", () => ({
  getLongLivedToken: mocks.longLived, getUserInfo: mocks.userInfo, subscribeInstagramAccountToWebhooks: mocks.subscribe,
}));
vi.mock("@/lib/meta/oauth", () => ({
  exchangeCodeForToken: mocks.exchange, verifyOAuthState: mocks.verifyState, encryptToken: (value: string) => `encrypted:${value}`,
}));
vi.mock("@/lib/instagram-accounts", () => ({ canConnectInstagramAccount: mocks.canConnect }));

import { FEAST_SESSION_COOKIE, FEAST_WORKSPACE_ID, getFeastConfig, isFeastMode, isFeastOwnedInstagramId } from "../lib/feast/config";
import { readLaunchToken, verifyFeastLaunchGrant } from "../lib/feast/launch-grant";
import { POST as launchSession } from "../app/api/feast/session/route";
import { GET as instagramCallback } from "../app/api/instagram/callback/route";
import { auth, handlers, signIn } from "../lib/auth";
import { proxy } from "../proxy";
import { POST as inviteMember } from "../app/api/workspace/members/route";
import { POST as acceptInvitation } from "../app/api/workspace/invitations/accept/route";
import { GET as health } from "../app/api/health/route";
import { GET as liveness } from "../app/api/feast/live/route";

const secret = "test-only-feast-secret-with-more-than-32-bytes";
const origin = "https://nudge.example.test";
const adminOrigin = "https://admin.example.test";
const now = Math.floor(Date.now() / 1000);
const grant = { version: 1, iss: "feast-admin", aud: origin, sub: "staff-123", jti: "83e5d437-b740-4d4e-b15d-1201709bca7b", iat: now, exp: now + 60 };

function signed(payload: Record<string, unknown> = grant, key = secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${createHmac("sha256", key).update(encoded).digest("base64url")}`;
}

function launchRequest(token = signed(), requestOrigin: string | null = adminOrigin) {
  return new NextRequest(`${origin}/api/feast/session`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...(requestOrigin ? { Origin: requestOrigin } : {}) },
    body: new URLSearchParams({ token }).toString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("FEAST_MODE", "true");
  vi.stubEnv("FEAST_SSO_SECRET", secret);
  vi.stubEnv("FEAST_ADMIN_ORIGIN", adminOrigin);
  vi.stubEnv("NEXTAUTH_URL", origin);
  vi.stubEnv("FEAST_SOURCE_URL", "https://github.com/example/nudge/tree/0123456789012345678901234567890123456789");
  vi.stubEnv("FEAST_OWNED_INSTAGRAM_IDS", "17840001,17840002");
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  mocks.redis.connect.mockResolvedValue(undefined);
  mocks.redis.set.mockResolvedValue("OK");
  mocks.prisma.$transaction.mockImplementation(async (callback) => callback(mocks.prisma));
  mocks.prisma.workspace.upsert.mockResolvedValue({ id: FEAST_WORKSPACE_ID, ownerId: "feast:staff-123" });
  mocks.prisma.workspaceMember.findUnique.mockResolvedValue({ workspaceId: FEAST_WORKSPACE_ID, role: "ADMIN" });
  mocks.rawAuth.mockResolvedValue({ user: { id: "feast:staff-123" }, expires: new Date(Date.now() + 3500_000).toISOString() });
  mocks.prisma.workspaceMember.findFirst.mockResolvedValue({ role: "ADMIN" });
  mocks.verifyState.mockReturnValue({ workspaceId: FEAST_WORKSPACE_ID });
  mocks.exchange.mockResolvedValue({ accessToken: "short" });
  mocks.longLived.mockResolvedValue({ accessToken: "long", expiresIn: 1000 });
  mocks.userInfo.mockResolvedValue({ user_id: "17840001", id: "app-scoped-id", username: "feast" });
  mocks.canConnect.mockResolvedValue({ allowed: true });
  mocks.subscribe.mockResolvedValue({ success: true });
});

afterEach(() => vi.unstubAllEnvs());

describe("Feast pilot configuration and launch grants", () => {
  it("fails closed when pilot mode is set without a secret or source offer", () => {
    vi.stubEnv("FEAST_SSO_SECRET", undefined);
    expect(isFeastMode()).toBe(true);
    expect(() => getFeastConfig()).toThrow();
    vi.stubEnv("FEAST_SSO_SECRET", secret);
    vi.stubEnv("FEAST_SOURCE_URL", undefined);
    expect(() => getFeastConfig()).toThrow();
  });

  it("treats a configured secret as pilot mode even without the explicit flag", () => {
    vi.stubEnv("FEAST_MODE", "false");
    expect(isFeastMode()).toBe(true);
  });

  it("rejects noncanonical origins, unlisted accounts, and empty allowlists", () => {
    vi.stubEnv("FEAST_ADMIN_ORIGIN", `${adminOrigin}/path`);
    expect(() => getFeastConfig()).toThrow();
    expect(isFeastOwnedInstagramId("17840001")).toBe(true);
    expect(isFeastOwnedInstagramId("17849999")).toBe(false);
    vi.stubEnv("FEAST_OWNED_INSTAGRAM_IDS", "");
    expect(isFeastOwnedInstagramId("17840001")).toBe(false);
  });

  it("accepts only exact, correctly signed, short-lived grants for this origin", () => {
    const config = getFeastConfig();
    expect(verifyFeastLaunchGrant(signed(), config, now)).toEqual(grant);
    for (const patch of [{ aud: adminOrigin }, { iss: "other" }, { exp: now }, { exp: now + 61 }, { iat: now + 6 }, { sub: "" }, { jti: "not-a-uuid" }, { email: "not-permitted@example.test" }]) {
      expect(verifyFeastLaunchGrant(signed({ ...grant, ...patch }), config, now)).toBeNull();
    }
    expect(verifyFeastLaunchGrant(signed(grant, "wrong-key"), config, now)).toBeNull();
    expect(verifyFeastLaunchGrant(`${signed()}=`, config, now)).toBeNull();
  });

  it("bounds actual body bytes and rejects duplicate token fields", async () => {
    const oversized = new Request(`${origin}/api/feast/session`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=" + "x".repeat(4096) });
    expect(await readLaunchToken(oversized)).toBeNull();
    const duplicate = new Request(`${origin}/api/feast/session`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "token=one&token=two" });
    expect(await readLaunchToken(duplicate)).toBeNull();
  });
});

describe("staff session exchange", () => {
  it("creates a fixed-workspace database session and secure one-hour cookie", async () => {
    const response = await launchSession(launchRequest());
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${origin}/campaigns`);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain(`${FEAST_SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=none");
    expect(cookie).toContain("Max-Age=3600");
    expect(mocks.redis.set).toHaveBeenCalledWith(`feast:launch:${grant.jti}`, "used", "EX", expect.any(Number), "NX");
    expect(mocks.prisma.workspaceMember.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: { workspaceId: FEAST_WORKSPACE_ID, userId: "feast:staff-123", role: "OWNER" } }));
    expect(mocks.prisma.session.create).toHaveBeenCalledOnce();
  });

  it("rejects a reused grant before creating another session", async () => {
    mocks.redis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    expect((await launchSession(launchRequest())).status).toBe(303);
    expect((await launchSession(launchRequest())).status).toBe(401);
    expect(mocks.prisma.session.create).toHaveBeenCalledOnce();
  });

  it("rejects missing or foreign Origin before consuming the grant", async () => {
    expect((await launchSession(launchRequest(signed(), null))).status).toBe(403);
    expect((await launchSession(launchRequest(signed(), "https://attacker.test"))).status).toBe(403);
    expect(mocks.redis.connect).not.toHaveBeenCalled();
  });

  it("does not create a session when signature or Redis verification fails", async () => {
    expect((await launchSession(launchRequest(signed(grant, "wrong-key")))).status).toBe(401);
    mocks.redis.connect.mockRejectedValueOnce(new Error("connection failed"));
    expect((await launchSession(launchRequest())).status).toBe(503);
    expect(mocks.prisma.session.create).not.toHaveBeenCalled();
  });

  it("rejects legacy users and staff without the internal membership", async () => {
    mocks.rawAuth.mockResolvedValueOnce({ user: { id: "legacy-user" }, expires: new Date(Date.now() + 1000).toISOString() });
    expect(await auth()).toBeNull();
    mocks.prisma.workspaceMember.findUnique.mockResolvedValueOnce(null);
    expect(await auth()).toBeNull();
    expect(mocks.prisma.workspaceMember.findUnique).toHaveBeenCalledWith({ where: { workspaceId_userId: { workspaceId: FEAST_WORKSPACE_ID, userId: "feast:staff-123" } } });
  });

  it("rejects expired sessions and old sessions exceeding the one-hour cap", async () => {
    expect(mocks.authConfiguration.current?.().session).toEqual({ strategy: "database", maxAge: 3600, updateAge: Number.MAX_SAFE_INTEGER });
    mocks.rawAuth.mockResolvedValueOnce({ user: { id: "feast:staff-123" }, expires: new Date(Date.now() - 1000).toISOString() });
    expect(await auth()).toBeNull();
    mocks.rawAuth.mockResolvedValueOnce({ user: { id: "feast:staff-123" }, expires: new Date(Date.now() + 7200_000).toISOString() });
    expect(await auth()).toBeNull();
  });

  it("never exposes adapter session credentials or private user fields", async () => {
    const user = { id: "feast:staff-123", name: "Feast staff", email: null, image: null, emailVerified: new Date() };
    const expires = new Date(Date.now() + 3500_000);
    const adapterSession = { id: "private-session-row", sessionToken: "private-bearer-token", userId: user.id, user, expires };
    const callbacks = mocks.authConfiguration.current?.().callbacks as {
      session: (input: { session: typeof adapterSession; user: typeof user }) => Promise<unknown>;
    };
    const publicSession = await callbacks.session({ session: adapterSession, user });
    expect(publicSession).toEqual({ user: { id: user.id, name: user.name, email: null, image: null }, expires });
    // auth() receives this JSON-serialized callback result from Auth.js.
    mocks.rawAuth.mockResolvedValueOnce(JSON.parse(JSON.stringify(publicSession)));
    const response = await handlers.GET(new NextRequest(`${origin}/api/auth/session`));
    expect(await response.json()).toEqual({
      user: { id: user.id, name: user.name, email: null, image: null }, expires: expires.toISOString(),
    });
    expect(adapterSession.sessionToken).toBe("private-bearer-token");
  });

  it("blocks magic-link server actions and provider API paths", async () => {
    await expect(signIn("resend", { email: "outside@example.test" })).rejects.toThrow("Feast Admin");
    expect((await handlers.POST(new NextRequest(`${origin}/api/auth/signin/resend`, { method: "POST" }))).status).toBe(403);
    expect((await handlers.GET(new NextRequest(`${origin}/api/auth/callback/resend`))).status).toBe(403);
    expect(mocks.rawSignIn).not.toHaveBeenCalled();
    expect(mocks.rawHandler).not.toHaveBeenCalled();
  });
});

describe("pilot boundary", () => {
  it("disables shared reports in pilot regardless of session cookies", () => {
    for (const path of ["/reports", "/reports/known-share-slug"]) {
      for (const cookie of [undefined, "authjs.session-token=legacy", `${FEAST_SESSION_COOKIE}=staff-token`]) {
        const response = proxy(new NextRequest(`${origin}${path}`, { headers: cookie ? { Cookie: cookie } : {} }));
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    vi.stubEnv("FEAST_MODE", "false");
    vi.stubEnv("FEAST_SSO_SECRET", undefined);
    expect(proxy(new NextRequest(`${origin}/reports/known-share-slug`)).status).toBe(200);
  });

  it("sets runtime frame ancestors and rejects cross-site mutations", () => {
    expect(proxy(new NextRequest(`${origin}/campaigns`)).headers.get("content-security-policy")).toBe(`frame-ancestors 'self' ${adminOrigin}`);
    expect(proxy(new NextRequest(`${origin}/api/automations`, { method: "POST", headers: { Origin: adminOrigin } })).status).toBe(403);
    expect(proxy(new NextRequest(`${origin}/api/automations`, { method: "POST", headers: { Origin: origin } })).status).toBe(200);
    expect(proxy(new NextRequest(`${origin}/api/webhook`, { method: "POST" })).status).toBe(200);
  });

  it("refuses an unowned Instagram account before storing or subscribing", async () => {
    mocks.userInfo.mockResolvedValueOnce({ user_id: "17849999", id: "other", username: "outside" });
    const response = await instagramCallback(new NextRequest(`${origin}/api/instagram/callback?code=code&state=signed`));
    expect(response.headers.get("location")).toBe(`${origin}/settings?instagram=forbidden`);
    expect(mocks.prisma.instagramAccount.upsert).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("refuses a callback for another workspace before exchanging tokens", async () => {
    mocks.verifyState.mockReturnValueOnce({ workspaceId: "other-workspace" });
    await instagramCallback(new NextRequest(`${origin}/api/instagram/callback?code=code&state=signed`));
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("disables invitation creation and acceptance at their direct API boundaries", async () => {
    const request = new NextRequest(`${origin}/api/workspace/members`, { method: "POST" });
    expect((await inviteMember(request)).status).toBe(403);
    expect((await acceptInvitation(request)).status).toBe(403);
  });

  it("protects detailed health while keeping liveness free of dependency details", async () => {
    mocks.rawAuth.mockResolvedValueOnce(null);
    expect((await health()).status).toBe(401);
    expect(await (await liveness()).json()).toEqual({ status: "ok" });
    vi.stubEnv("FEAST_SSO_SECRET", undefined);
    expect((await liveness()).status).toBe(503);
  });
});
