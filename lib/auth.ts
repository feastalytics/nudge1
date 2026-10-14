import NextAuth, { type NextAuthConfig } from "next-auth";
import Resend from "next-auth/providers/resend";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser, getPrimaryWorkspace } from "@/lib/workspace";
import { FEAST_SESSION_COOKIE, FEAST_SESSION_SECONDS, FEAST_WORKSPACE_ID, getFeastConfig, isFeastMode, isFeastStaffId } from "@/lib/feast/config";

type AdapterPrismaClient = Parameters<typeof PrismaAdapter>[0];

function createAuthConfig(): NextAuthConfig {
  const pilot = isFeastMode();
  if (pilot) getFeastConfig();
  return {
  adapter: PrismaAdapter(prisma as unknown as AdapterPrismaClient),
  providers: pilot ? [] : [
    Resend({
      apiKey: process.env.RESEND_API_KEY ?? "missing-resend-api-key",
      from: process.env.EMAIL_FROM ?? "Nudge1 <login@example.com>",
    }),
  ],
  callbacks: {
    async signIn() {
      return !isFeastMode();
    },
    async session({ session, user }) {
      // Database adapters include the bearer token and internal row fields.
      // Only these public fields may reach browser session responses.
      return {
        user: { id: user.id, name: user.name, email: user.email, image: user.image },
        expires: session.expires,
      };
    },
  },
  events: {
    async createUser({ user }) {
      if (user.id) {
        await ensureWorkspaceForUser(user.id, user.email);
      }
    },
  },
  pages: {
    signIn: "/login",
    verifyRequest: "/verify-request",
  },
  session: {
    strategy: "database",
    // The DB expiry is fixed at SSO exchange; Auth.js must never slide it.
    ...(pilot ? { maxAge: FEAST_SESSION_SECONDS, updateAge: Number.MAX_SAFE_INTEGER } : {}),
  },
  ...(pilot ? {
    cookies: {
      sessionToken: {
        name: FEAST_SESSION_COOKIE,
        options: { httpOnly: true, secure: true, sameSite: "none" as const, path: "/" },
      },
    },
  } : {}),
  trustHost: true,
  secret: process.env.NEXTAUTH_SECRET,
  } satisfies NextAuthConfig;
}

const nextAuth = NextAuth(createAuthConfig);

export async function auth() {
  const session = await nextAuth.auth();
  if (!isFeastMode()) return session;
  getFeastConfig();
  if (!session || !isFeastStaffId(session.user?.id)) return null;
  const expiry = Date.parse(session.expires);
  if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + FEAST_SESSION_SECONDS * 1000) return null;
  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: FEAST_WORKSPACE_ID, userId: session.user.id } },
  });
  if (!membership || !["OWNER", "ADMIN"].includes(membership.role)) return null;
  return session;
}

export async function signIn(...args: Parameters<typeof nextAuth.signIn>) {
  if (isFeastMode()) throw new Error("Open Nudge1 from Feast Admin to sign in.");
  return nextAuth.signIn(...args);
}

export const signOut = nextAuth.signOut;

function protectedAuthHandler(method: "GET" | "POST"): typeof nextAuth.handlers.GET {
  return async (request) => {
    if (!isFeastMode()) return nextAuth.handlers[method](request);
    getFeastConfig();
    const action = new URL(request.url).pathname.split("/").pop();
    if (action === "session" && method === "GET") {
      return Response.json(await auth(), { headers: { "Cache-Control": "no-store" } });
    }
    if (action === "csrf" || action === "signout") return nextAuth.handlers[method](request);
    return Response.json({ error: "Open Nudge1 from Feast Admin to sign in." }, { status: 403 });
  };
}

export const handlers = { GET: protectedAuthHandler("GET"), POST: protectedAuthHandler("POST") };

export async function getCurrentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

export async function getCurrentWorkspaceId(): Promise<string | null> {
  const userId = await getCurrentUserId();
  if (!userId) return null;

  const workspace = await getPrimaryWorkspace(userId);
  if (workspace) return workspace.id;
  if (isFeastMode()) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  const createdWorkspace = await ensureWorkspaceForUser(userId, user?.email);
  return createdWorkspace.id;
}
