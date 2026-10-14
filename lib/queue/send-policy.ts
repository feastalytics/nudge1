/** Fail closed for the staff-only pilot; evaluated at dispatch time as well as ingestion. */
export function isFeastPilot(): boolean {
  return process.env.FEAST_MODE === "true" || process.env.FEAST_SSO_SECRET !== undefined;
}

export function isOwnedInstagramAccount(id: string): boolean {
  if (!isFeastPilot()) return true;
  return /^\d+$/.test(id) && (process.env.FEAST_OWNED_INSTAGRAM_IDS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean).includes(id);
}

export function isSendingEnabled(): boolean {
  return isFeastPilot() ? process.env.FEAST_SEND_ENABLED === "true" : process.env.FEAST_SEND_ENABLED !== "false";
}

export class SendDisabledError extends Error {
  constructor() { super("Instagram sends are disabled or account is not allowed"); }
}

export function assertSendAllowed(id: string | undefined): void {
  if (!isSendingEnabled() || (isFeastPilot() && (!id || !isOwnedInstagramAccount(id)))) {
    throw new SendDisabledError();
  }
}
