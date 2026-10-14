import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const grantSchema = z.object({
  version: z.literal(1),
  iss: z.literal("feast-admin"),
  aud: z.string(),
  sub: z.string().min(1).max(200).regex(/^[^\s\u0000-\u001f\u007f]+$/),
  jti: z.string().uuid(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
}).strict();

export type FeastLaunchGrant = z.infer<typeof grantSchema>;

export function verifyFeastLaunchGrant(
  token: string,
  config: { secret: string; serviceOrigin: string },
  now = Math.floor(Date.now() / 1000)
): FeastLaunchGrant | null {
  if (token.length > 3000) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;
  const [payload, signature] = parts;
  const expected = createHmac("sha256", config.secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || received.toString("base64url") !== signature || !timingSafeEqual(expected, received)) return null;
  try {
    const decoded = Buffer.from(payload, "base64url");
    if (decoded.toString("base64url") !== payload) return null;
    const parsed = grantSchema.safeParse(JSON.parse(decoded.toString("utf8")));
    if (!parsed.success) return null;
    const grant = parsed.data;
    if (grant.aud !== config.serviceOrigin || grant.iat > now + 5 || grant.exp <= now || grant.exp <= grant.iat || grant.exp - grant.iat > 60) return null;
    return grant;
  } catch {
    return null;
  }
}

export async function readLaunchToken(request: Request): Promise<string | null> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/x-www-form-urlencoded") return null;
  const declaredSize = request.headers.get("content-length");
  if (declaredSize !== null && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > 4096)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(body);
  if ([...params.keys()].some((key) => key !== "token") || params.getAll("token").length !== 1) return null;
  return params.get("token");
}
