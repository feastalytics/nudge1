import Redis from "ioredis";
import type { FeastLaunchGrant } from "./launch-grant";

export async function consumeFeastLaunchGrant(grant: FeastLaunchGrant): Promise<boolean> {
  if (!process.env.REDIS_URL) throw new Error("Redis is required for Feast sessions");
  const redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 3000,
    retryStrategy: () => null,
  });
  // The route returns a generic failure; never emit connection strings or grants.
  redis.on("error", () => {});
  try {
    await redis.connect();
    const remaining = grant.exp - Math.floor(Date.now() / 1000);
    if (remaining <= 0) return false;
    return await redis.set(`feast:launch:${grant.jti}`, "used", "EX", remaining, "NX") === "OK";
  } finally {
    redis.disconnect();
  }
}
