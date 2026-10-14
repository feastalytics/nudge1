import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { FEAST_SESSION_COOKIE, FEAST_SESSION_SECONDS, FEAST_WORKSPACE_ID, getFeastConfig, isFeastMode } from "@/lib/feast/config";
import { readLaunchToken, verifyFeastLaunchGrant } from "@/lib/feast/launch-grant";
import { consumeFeastLaunchGrant } from "@/lib/feast/replay";

export const runtime = "nodejs";

function failure(status: number) {
  return NextResponse.json({ error: "Open Nudge1 from Feast Admin to sign in." }, {
    status,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export async function POST(request: NextRequest) {
  if (!isFeastMode()) return failure(404);
  try {
    const config = getFeastConfig();
    if (request.headers.get("origin") !== config.adminOrigin) return failure(403);
    const token = await readLaunchToken(request);
    const grant = token ? verifyFeastLaunchGrant(token, config) : null;
    if (!grant || !await consumeFeastLaunchGrant(grant)) return failure(401);

    const userId = `feast:${grant.sub}`;
    const sessionToken = randomBytes(32).toString("base64url");
    const expires = new Date(Date.now() + FEAST_SESSION_SECONDS * 1000);
    await prisma.$transaction(async (tx) => {
      await tx.user.upsert({ where: { id: userId }, create: { id: userId, name: "Feast staff" }, update: {} });
      const workspace = await tx.workspace.upsert({
        where: { id: FEAST_WORKSPACE_ID },
        create: { id: FEAST_WORKSPACE_ID, name: "Feast Internal", ownerId: userId, alertsEnabled: false },
        update: {},
      });
      const role = workspace.ownerId === userId ? "OWNER" : "ADMIN";
      await tx.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: FEAST_WORKSPACE_ID, userId } },
        create: { workspaceId: FEAST_WORKSPACE_ID, userId, role },
        update: { role },
      });
      await tx.session.create({ data: { sessionToken, userId, expires } });
    });

    const response = NextResponse.redirect(new URL("/campaigns", config.serviceOrigin), 303);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(FEAST_SESSION_COOKIE, sessionToken, {
      httpOnly: true, secure: true, sameSite: "none", path: "/", maxAge: FEAST_SESSION_SECONDS, expires,
    });
    return response;
  } catch {
    return failure(503);
  }
}
