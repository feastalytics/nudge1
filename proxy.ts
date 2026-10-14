import { NextRequest, NextResponse } from "next/server";
import { getFeastConfig, hasAllowedMutationOrigin, isFeastMode } from "@/lib/feast/config";

const SEPARATELY_AUTHENTICATED = new Set([
  "/api/feast/session",
  "/api/webhook",
  "/api/cron/refresh-tokens",
  "/api/cron/attach-next-reel",
]);

function genericProxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const protectedPrefixes = ["/dashboard", "/automations", "/logs", "/settings"];
  const protectedPath = protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  const authenticated = ["authjs.session-token", "__Secure-authjs.session-token", "next-auth.session-token", "__Secure-next-auth.session-token"].some((name) => request.cookies.has(name));
  if (protectedPath && !authenticated) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }
  if ((pathname === "/login" || pathname === "/") && authenticated) {
    return NextResponse.redirect(new URL("/campaigns", request.url));
  }
  return NextResponse.next();
}

export function proxy(request: NextRequest) {
  if (!isFeastMode()) return genericProxy(request);
  try {
    const config = getFeastConfig();
    const path = request.nextUrl.pathname;
    // Shared reports bypass dashboard authentication in upstream Nudge.
    // Public sharing is unavailable in the staff-only pilot.
    if (path === "/reports" || path.startsWith("/reports/")) {
      return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        !SEPARATELY_AUTHENTICATED.has(path) &&
        !hasAllowedMutationOrigin(request, config.serviceOrigin)) {
      return NextResponse.json({ error: "Invalid request origin" }, { status: 403 });
    }
    const response = path === "/" || path.startsWith("/invite/")
      ? NextResponse.redirect(new URL("/login", config.serviceOrigin))
      : NextResponse.next();
    response.headers.set("Content-Security-Policy", `frame-ancestors 'self' ${config.adminOrigin}`);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  } catch {
    return NextResponse.json({ error: "Feast access is not configured" }, { status: 503 });
  }
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };
