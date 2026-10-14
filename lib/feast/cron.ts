import { timingSafeEqual } from "node:crypto";
import { FEAST_WORKSPACE_ID, getFeastConfig, isFeastMode, isFeastOwnedInstagramId } from "./config";

/** Preserve the legacy secret fallback, but never authenticate a missing value. */
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;
  if (!secret?.trim()) return false;
  try {
    if (isFeastMode()) getFeastConfig();
    const expected = Buffer.from(`Bearer ${secret}`);
    const received = Buffer.from(request.headers.get("authorization") ?? "");
    return received.length === expected.length && timingSafeEqual(received, expected);
  } catch {
    return false;
  }
}

export function cronAccountFilter() {
  if (!isFeastMode()) return {};
  const allowedIds = (process.env.FEAST_OWNED_INSTAGRAM_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => isFeastOwnedInstagramId(id));
  return { workspaceId: FEAST_WORKSPACE_ID, instagramId: { in: allowedIds } };
}

/** Recheck before touching tokens or making requests, as well as in queries. */
export function isCronAccountAllowed(account: { workspaceId: string; instagramId: string }): boolean {
  return !isFeastMode() ||
    (account.workspaceId === FEAST_WORKSPACE_ID && isFeastOwnedInstagramId(account.instagramId));
}
