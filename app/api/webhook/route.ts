import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { verifyWebhookSignature } from "@/lib/meta/webhook";
import { Prisma } from "@/app/generated/prisma/client";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 1024 * 1024;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  if (process.env.WEBHOOK_VERIFY_TOKEN && params.get("hub.mode") === "subscribe" &&
      params.get("hub.verify_token") === process.env.WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(params.get("hub.challenge"), { status: 200 });
  }
  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

async function readBoundedBody(request: NextRequest): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("Body too large"); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(request: NextRequest) {
  let rawBody: string;
  try { rawBody = await readBoundedBody(request); }
  catch { return NextResponse.json({ error: "Payload too large" }, { status: 413 }); }

  try {
    if (!verifyWebhookSignature(rawBody, request.headers.get("x-hub-signature-256"))) {
      // Never log untrusted message text, signatures or credentials.
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } catch { return NextResponse.json({ error: "Webhook unavailable" }, { status: 503 }); }

  let payload: Prisma.InputJsonValue;
  try {
    payload = JSON.parse(rawBody);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
  } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  try {
    // HTTP 200 means Postgres has durably accepted responsibility. Redis is
    // deliberately absent from the request path; the worker replays receipts.
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");
    await prisma.webhookEvent.upsert({
      where: { payloadHash },
      create: { payloadHash, object: "object" in payload ? String(payload.object) : null, payload, status: "PENDING" },
      update: {},
    });
    return NextResponse.json({ success: true });
  } catch {
    // No durable acceptance: ask Meta to redeliver instead of acknowledging.
    return NextResponse.json({ error: "Webhook storage unavailable" }, { status: 503 });
  }
}
