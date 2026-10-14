import { createDMWorker } from "@/lib/queue/dm-worker";
import { recordWorkerHeartbeat } from "@/lib/ops/worker-health";
import { reconcileComments } from "@/lib/polling/comment-reconciler";
import os from "node:os";
import { closeQueueConnections } from "@/lib/queue/client";
import { replayWebhookReceipts, dispatchOutbox } from "@/lib/queue/outbox";
import { recoverInterruptedDeliveries } from "@/lib/queue/delivery";
import { prisma } from "@/lib/db/client";

const worker = createDMWorker();
const startedAt = new Date().toISOString();
// TTL on the heartbeat key is 120s (see recordWorkerHeartbeat) — 60s keeps a
// 2x safety margin while halving the SET-command cost of idle polling.
const HEARTBEAT_INTERVAL_MS = 60_000;
// Polling safety net for comments that webhooks miss. Runs in the worker because
// it must fire every few minutes and Vercel's free crons only run once a day.
// 20 min, not 5: on Neon's free tier, a poll every 5 min lands right on the
// default 5-min autosuspend threshold, so the database rarely gets a real
// idle window and racks up compute hours even with zero real traffic.
const configuredPollInterval = Number(process.env.COMMENT_POLL_INTERVAL_MS ?? 20 * 60_000);
const POLL_INTERVAL_MS = Number.isFinite(configuredPollInterval) ? Math.max(60_000, configuredPollInterval) : 20 * 60_000;

console.log("[DM Worker] Started");

async function heartbeat() {
  try {
    await recordWorkerHeartbeat({
      pid: process.pid,
      hostname: os.hostname(),
      startedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Heartbeat failed:", message);
  }
}

void heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL_MS);

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    await reconcileComments();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[DM Worker] Comment reconciliation failed:", message);
  } finally { polling = false; }
}

// Kick off one sweep shortly after boot, then on a fixed interval.
const initialPollTimer = setTimeout(() => void poll(), 10_000);
const pollTimer = setInterval(() => void poll(), POLL_INTERVAL_MS);

// Durable receipt replay and lost-Redis recovery do not depend on comment
// polling. Polling cannot recover button taps, but this journal can.
let recovery: Promise<void> | null = null;
async function recover() {
  if (recovery) return;
  recovery = (async () => {
    await recoverInterruptedDeliveries();
    await replayWebhookReceipts();
    await dispatchOutbox();
  })();
  try { await recovery; }
  catch { console.error("[DM Worker] Durable recovery failed; retrying next interval"); }
  finally { recovery = null; }
}
void recover();
const recoveryTimer = setInterval(() => void recover(), 15_000);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[DM Worker] ${signal} received, closing worker`);
  clearInterval(heartbeatTimer);
  clearInterval(pollTimer);
  clearInterval(recoveryTimer);
  clearTimeout(initialPollTimer);
  // ECS stop timeout exceeds this deadline. Interrupted claims remain durable
  // and are quarantined on restart rather than silently marked as sent.
  const deadline = setTimeout(() => process.exit(1), 90_000);
  deadline.unref();
  await worker.close();
  await recovery?.catch(() => {});
  await closeQueueConnections();
  await prisma.$disconnect();
  clearTimeout(deadline);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
