// Background worker: runs the scheduled jobs (reminders, expiry, reconciliation).
// Start with `npm run worker` (development: `npm run worker:dev`). Run ONE OR MORE copies next to the API;
// BullMQ makes sure each scheduled run is processed by only one worker.
import { Worker } from 'bullmq';
import { env } from './config/env.js';
import { JOB_NAMES, JOB_TIMEZONE, JOBS, isJobName } from './jobs/definitions.js';
import { closeJobsQueue, jobsQueue, QUEUE_NAME, QUEUE_PREFIX, queueConnection } from './jobs/queue.js';
import { logger } from './lib/logger.js';
import { connectMongo, disconnectMongo } from './lib/mongo.js';

// Makes Redis hold exactly the schedules in JOBS (adds new ones, updates changed ones, removes old ones)
async function registerSchedules(): Promise<void> {
  const queue = jobsQueue();
  for (const name of JOB_NAMES) {
    await queue.upsertJobScheduler(name, { pattern: JOBS[name].cron, tz: JOB_TIMEZONE }, { name, data: { scheduled: true } });
  }
  for (const s of await queue.getJobSchedulers()) {
    if (!isJobName(s.key)) await queue.removeJobScheduler(s.key);
  }
  logger.info({ jobs: JOB_NAMES.length, timezone: JOB_TIMEZONE }, 'Job schedules registered');
}

async function main(): Promise<void> {
  await connectMongo();
  await registerSchedules();

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (!isJobName(job.name)) throw new Error(`Unknown job: ${job.name}`);
      const log = logger.child({ jobId: job.id, job: job.name, attempt: job.attemptsMade + 1 });
      log.info('Job started');
      const result = await JOBS[job.name].run();
      log.info({ result }, 'Job finished');
      return result; // stored with the job; the admin panel shows it
    },
    { connection: queueConnection(), prefix: QUEUE_PREFIX, concurrency: 1 },
  );
  worker.on('failed', (job, err) => logger.error({ err, jobId: job?.id, job: job?.name, attempts: job?.attemptsMade }, 'Job failed'));
  worker.on('error', (err) => logger.error({ err }, 'Worker error'));
  logger.info({ env: env.NODE_ENV }, 'Worker started');

  // Graceful shutdown: finish the job in progress, then close connections
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Worker shutting down');
    const force = setTimeout(() => process.exit(1), 60_000);
    force.unref();
    await worker.close();
    await Promise.allSettled([closeJobsQueue(), disconnectMongo()]);
    logger.info('Worker stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'Unhandled promise rejection');
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Worker failed to start');
  process.exit(1);
});
