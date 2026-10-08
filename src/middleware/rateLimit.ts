import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { tooManyRequests } from '../lib/errors.js';
import { redis } from '../lib/redis.js';

// Limits are counted in Redis, so they still work when several API containers run.
export type LimiterName = 'global' | 'login' | 'register' | 'otp' | 'refresh' | 'publicRead';
export type Limiters = Record<LimiterName, RequestHandler>;

const ipOf = (req: Request) => ipKeyGenerator(req.ip ?? '0.0.0.0');

const RULES: Record<LimiterName, { windowMs: number; limit: number; key?: (req: Request) => string }> = {
  global: { windowMs: 60_000, limit: 300 },
  // per IP + identifier, so one attacker cannot lock out every user behind the same office IP
  login: {
    windowMs: 15 * 60_000,
    limit: 10,
    key: (req) => {
      const body: unknown = req.body;
      const identifier =
        typeof body === 'object' && body !== null && 'identifier' in body && typeof body.identifier === 'string'
          ? body.identifier.trim().toLowerCase()
          : '';
      return `${ipOf(req)}:${identifier}`;
    },
  },
  register: { windowMs: 60 * 60_000, limit: 10 },
  otp: { windowMs: 15 * 60_000, limit: 15 },
  refresh: { windowMs: 15 * 60_000, limit: 60 },
  publicRead: { windowMs: 60_000, limit: 60 },
};

const passThrough: RequestHandler = (_req: Request, _res: Response, next: NextFunction) => next();

export function createLimiters(enabled: boolean): Limiters {
  const entries = Object.entries(RULES).map(([name, rule]) => {
    if (!enabled) return [name, passThrough] as const;
    const handler = rateLimit({
      windowMs: rule.windowMs,
      limit: rule.limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      passOnStoreError: true, // if Redis is down, keep serving instead of blocking every user
      keyGenerator: rule.key ?? ipOf,
      store: new RedisStore({
        prefix: `rl:${name}:`,
        sendCommand: (command: string, ...args: string[]) => redis.call(command, ...args) as Promise<RedisReply>,
      }),
      handler: (_req, _res, next) => next(tooManyRequests('Too many attempts. Please wait and try again.')),
    });
    return [name, handler] as const;
  });
  return Object.fromEntries(entries) as Limiters;
}
