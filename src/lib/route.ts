// A small route helper used by every module.
// Each route is described once (method, path, who may call it, input schemas, handler);
// the same description builds the Express route AND the Swagger/OpenAPI documentation.
import type { Request, RequestHandler, Response, Router } from 'express';
import multer from 'multer';
import { env } from '../config/env.js';
import type { z, ZodType } from 'zod';
import { authenticate, requirePermission, type AuthContext } from '../middleware/auth.js';
import type { LimiterName, Limiters } from '../middleware/rateLimit.js';
import type { Permission } from '../modules/roles/permissions.js';
import type { FeatureKey } from '../modules/subscription/plans.js';
import { requireFeature } from '../modules/subscription/subscription.service.js';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
type Access = 'public' | 'user';
type Infer<T> = T extends ZodType ? z.output<T> : T extends undefined ? undefined : unknown;

export type RouteContext<B, Q, P, A extends Access> = {
  body: Infer<B>;
  query: Infer<Q>;
  params: Infer<P>;
  auth: A extends 'user' ? AuthContext : null;
  file: Express.Multer.File | undefined; // only for routes with `fileField`
  req: Request;
  res: Response;
};

type RouteSpec<B, Q, P, A extends Access> = {
  method: Method;
  path: string; // Express style, e.g. /users/:id
  tag: string;
  summary: string;
  description?: string;
  access: A;
  permission?: Permission;
  feature?: FeatureKey; // paid-plan feature the advisor's subscription must include
  limiter?: LimiterName;
  body?: B;
  query?: Q;
  params?: P;
  status?: number; // success status, default 200 (204 when the handler returns nothing)
  fileField?: string; // multipart upload: name of the file field (other fields arrive in `body`)
  handler: (ctx: RouteContext<B, Q, P, A>) => unknown;
};

// The stored, type-erased form used by the router and the docs generator
export type RouteDef = Omit<RouteSpec<ZodType, ZodType, ZodType, Access>, 'handler' | 'body' | 'query' | 'params'> & {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
  handler: (ctx: RouteContext<unknown, unknown, unknown, Access>) => unknown;
};

export function defineRoute<
  B extends ZodType | undefined = undefined,
  Q extends ZodType | undefined = undefined,
  P extends ZodType | undefined = undefined,
  A extends Access = 'user',
>(spec: RouteSpec<B, Q, P, A>): RouteDef {
  return spec; // stored type-erased; each handler was already type-checked against its schemas
}

// Uploads are kept in memory only long enough to check and store them (size-limited, one file)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10 } });

export function mountRoutes(router: Router, routes: RouteDef[], limiters: Limiters): void {
  for (const r of routes) {
    const chain: RequestHandler[] = [];
    if (r.limiter) chain.push(limiters[r.limiter]);
    if (r.access === 'user') chain.push(authenticate);
    if (r.permission) chain.push(requirePermission(r.permission));
    if (r.feature) {
      const feature = r.feature;
      chain.push(async (req, _res, next) => {
        if (req.auth?.orgId) await requireFeature(req.auth.orgId, feature);
        next();
      });
    }
    if (r.fileField) chain.push(upload.single(r.fileField)); // after the permission check: no upload without rights
    chain.push(async (req, res) => {
      const result = await r.handler({
        body: r.body ? r.body.parse(req.body ?? {}) : undefined,
        query: r.query ? r.query.parse(req.query) : undefined,
        params: r.params ? r.params.parse(req.params) : undefined,
        auth: req.auth ?? null,
        file: req.file,
        req,
        res,
      });
      if (res.headersSent) return;
      if (result === undefined) res.status(r.status ?? 204).end();
      else res.status(r.status ?? 200).json(result);
    });
    router[r.method](r.path, ...chain);
  }
}
