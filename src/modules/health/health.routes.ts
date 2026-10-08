import { Router } from 'express';
import { pingMongo } from '../../lib/mongo.js';
import { pingRedis } from '../../lib/redis.js';

// /health = the process is running (liveness). /ready = it can reach MongoDB and Redis (readiness).
export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptimeSec: Math.round(process.uptime()) });
});

healthRouter.get('/ready', async (_req, res) => {
  const [mongo, redis] = await Promise.all([pingMongo(), pingRedis()]);
  const ok = mongo && redis;
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not_ready', mongo, redis });
});
