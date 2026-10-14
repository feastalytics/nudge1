/**
 * BullMQ Queue Client
 *
 * Provides the DM processing queue and Redis connection for BullMQ.
 */

import { Queue } from "bullmq";
import Redis from "ioredis";

let connection: Redis | null = null;
let producerConnection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: null, // Required by BullMQ
    });
  }
  return connection;
}

// Producers must fail promptly while Redis is unavailable. Worker blocking
// connections use the separate unlimited-retry connection above.
export function getQueueProducerConnection(): Redis {
  if (!producerConnection) {
    producerConnection = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 1,
      commandTimeout: 5000,
      connectTimeout: 5000,
      enableOfflineQueue: false,
    });
  }
  return producerConnection;
}

export async function closeQueueConnections(): Promise<void> {
  await dmQueue?.close();
  connection?.disconnect();
  producerConnection?.disconnect();
}

// ─── DM Queue ───────────────────────────────────────────────────────────────────

export type CommentSource = "WEBHOOK" | "POLLING";

export interface ProcessCommentJob {
  instagramAccountId: string;
  commentId: string;
  commentText: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
  requeueAttempt?: number;
  outboxId?: string;
  // Which path enqueued this comment. Recorded in the shared ProcessedComment
  // dedup store so the reconciler can tell webhook- from polling-caught comments.
  source?: CommentSource;
  ownerHasReplied?: boolean;
}

// Delivered when a user taps an opening DM's button — carries the reveal target.
export interface ProcessPostbackJob {
  instagramAccountId: string;
  userId: string;
  payload: string;
  mid?: string;
  outboxId?: string;
}

export type DmQueueJob = ProcessCommentJob | ProcessPostbackJob;

export const POSTBACK_JOB_NAME = "process-postback";

let dmQueue: Queue<DmQueueJob> | null = null;

export function getDMQueue(): Queue<DmQueueJob> {
  if (!dmQueue) {
    dmQueue = new Queue<DmQueueJob>("dm-processing", {
      connection: getQueueProducerConnection(),
      defaultJobOptions: {
        removeOnComplete: { count: 1000 }, // Keep last 1000 completed jobs
        // Outbox retains unfinished work in Postgres and explicitly removes
        // exhausted Redis ids before replay; age cleanup alone is lazy.
        removeOnFail: { age: 300, count: 2000 },
        attempts: 3,
        backoff: {
          type: "custom",
        },
      },
    });
  }
  return dmQueue;
}
