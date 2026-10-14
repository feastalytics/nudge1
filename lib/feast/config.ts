export const FEAST_WORKSPACE_ID = "feast-internal";
export const FEAST_SESSION_SECONDS = 60 * 60;
export const FEAST_SESSION_COOKIE = "__Secure-authjs.session-token";

type Environment = Record<string, string | undefined>;

export function isFeastMode(env: Environment = process.env): boolean {
  return env.FEAST_MODE === "true" || env.FEAST_SSO_SECRET !== undefined;
}

export function requireHttpsOrigin(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error(`${name} must be a canonical HTTPS origin`);
  }
  return url.origin;
}

export function getFeastConfig(env: Environment = process.env) {
  if (!isFeastMode(env)) throw new Error("Feast access is not enabled");
  const secret = env.FEAST_SSO_SECRET;
  if (!secret?.trim() || new TextEncoder().encode(secret).length < 32) {
    throw new Error("FEAST_SSO_SECRET must contain at least 32 bytes");
  }
  const adminOrigin = requireHttpsOrigin(env.FEAST_ADMIN_ORIGIN, "FEAST_ADMIN_ORIGIN");
  const serviceOrigin = requireHttpsOrigin(env.NEXTAUTH_URL, "NEXTAUTH_URL");
  if (!env.FEAST_SOURCE_URL) throw new Error("FEAST_SOURCE_URL is required");
  const source = new URL(env.FEAST_SOURCE_URL);
  if (source.protocol !== "https:" || source.username || source.password || source.hash || source.pathname === "/") {
    throw new Error("FEAST_SOURCE_URL must link to the matching HTTPS source revision");
  }
  return { secret, adminOrigin, serviceOrigin, sourceUrl: source.href };
}

export function isFeastStaffId(userId: string | null | undefined): userId is string {
  return typeof userId === "string" && /^feast:[^\s\u0000-\u001f\u007f]{1,200}$/.test(userId);
}

export function isFeastOwnedInstagramId(instagramId: string, env: Environment = process.env): boolean {
  if (!isFeastMode(env)) return true;
  const ids = (env.FEAST_OWNED_INSTAGRAM_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  return /^\d+$/.test(instagramId) && ids.includes(instagramId);
}

export function hasAllowedMutationOrigin(request: Request, serviceOrigin: string): boolean {
  return request.headers.get("origin") === serviceOrigin;
}
