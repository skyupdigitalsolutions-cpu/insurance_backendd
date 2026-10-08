import type { Server } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closeJobsQueue } from './jobs/queue.js';
import { logger } from './lib/logger.js';
import { connectMongo, disconnectMongo } from './lib/mongo.js';
import { connectRedis, disconnectRedis } from './lib/redis.js';

async function main(): Promise<void> {
  await connectMongo();
  await connectRedis();

  const server: Server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, `API listening on http://localhost:${env.PORT}/api/v1`);
  });

  // Graceful shutdown: stop taking new requests, finish current ones, then close connections
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(async () => {
      await Promise.allSettled([disconnectMongo(), disconnectRedis(), closeJobsQueue()]);
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (err) => {
  logger.fatal({ err }, 'Unhandled promise rejection');
  process.exit(1);
});

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
