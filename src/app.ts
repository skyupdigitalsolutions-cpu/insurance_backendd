import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { corsOrigins, env } from './config/env.js';
import { buildOpenApi } from './docs/openapi.js';
import { logger } from './lib/logger.js';
import { mountRoutes } from './lib/route.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { createLimiters } from './middleware/rateLimit.js';
import { healthRouter } from './modules/health/health.routes.js';
import { checkoutRouter } from './modules/payments/checkout.js';
import { API_BASE, allRoutes } from './routes.js';

export type AppOptions = { rateLimit?: boolean };

// Builds the Express app without starting it (the tests use this directly)
export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      // one short line per request (no headers, no bodies)
      serializers: {
        req: (req: { id: unknown; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(helmet());
  // Browsers (web admin panel) must be on the allow-list; the mobile app sends no Origin header
  app.use(cors({ origin: corsOrigins, credentials: false }));
  // Keep the exact bytes too: webhook signatures are calculated on the raw body
  app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { (req as express.Request).rawBody = buf; } }));

  app.use(healthRouter);
  if (env.PAYMENT_PROVIDER === 'mock') app.use(checkoutRouter); // practice payment page (never in production)

  if (env.API_DOCS_ENABLED) {
    const spec = buildOpenApi(allRoutes, API_BASE);
    app.get('/api/docs.json', (_req, res) => { res.json(spec); });
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec, { customSiteTitle: 'Insurance API docs' }));
  }

  const limiters = createLimiters(options.rateLimit ?? env.RATE_LIMIT_ENABLED);
  const api = express.Router();
  api.use(limiters.global);
  mountRoutes(api, allRoutes, limiters);
  app.use(API_BASE, api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
