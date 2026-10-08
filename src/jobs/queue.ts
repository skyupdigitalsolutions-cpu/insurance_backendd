// The job queue lives in Redis (BullMQ). The API only adds "run now" jobs and reads job status;
// the separate worker process (src/worker.ts) does the work.
// Retries: 3 attempts with exponential back-off (1, 2, 4 minutes). Failed jobs are kept for the admin panel.
import { Queue, type ConnectionOptions } from 'bullmq';
import { env } from '../config/env.js';

export const QUEUE_NAME = 'jobs';
// Keys start with "bull:<environment>", so staging and production never mix even on one Redis server
export const QUEUE_PREFIX = `bull:${env.NODE_ENV}`;

// BullMQ needs its own connections with maxRetriesPerRequest = null (it waits on Redis by design)
export const queueConnection = (): ConnectionOptions => ({ url: env.REDIS_URL, maxRetriesPerRequest: null });

let queue: Queue | null = null;

// Created on first use, so API instances that never touch jobs open no extra connection
export function jobsQueue(): Queue {
  queue ??= new Queue(QUEUE_NAME, {
    connection: queueConnection(),
    prefix: QUEUE_PREFIX,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    },
  });
  return queue;
}

export async function closeJobsQueue(): Promise<void> {
  if (queue) await queue.close();
  queue = null;
}
