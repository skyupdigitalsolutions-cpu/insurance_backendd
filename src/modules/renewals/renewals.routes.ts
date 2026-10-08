import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { idParams, optionalText } from '../../lib/validators.js';
import { closeRenewal, getRenewal, listRenewals, logRenewalContact } from './renewals.service.js';

export const renewalRoutes = [
  defineRoute({
    method: 'get', path: '/renewals', tag: 'Renewals', summary: 'Policies due for renewal (soonest first)',
    access: 'user', permission: 'renewal:read',
    query: z.object({ window: z.enum(['overdue', '7d', '30d', 'all']).default('30d'), limit: z.coerce.number().int().min(1).max(200).default(100) }),
    handler: ({ auth, query }) => listRenewals(orgIdOf(auth), query.window, query.limit),
  }),
  defineRoute({
    method: 'get', path: '/renewals/:id', tag: 'Renewals', summary: 'One renewal (id = policy id) with contact history',
    access: 'user', permission: 'renewal:read', params: idParams,
    handler: ({ auth, params }) => getRenewal(orgIdOf(auth), params.id),
  }),
  defineRoute({
    method: 'post', path: '/renewals/:id/activities', tag: 'Renewals', summary: 'Log a renewal call / contact',
    access: 'user', permission: 'renewal:manage', params: idParams, status: 201,
    body: z.object({ outcome: z.string().trim().min(1, 'Choose an outcome').max(60), notes: optionalText(1000) }),
    handler: ({ auth, params, body }) => logRenewalContact(auth, orgIdOf(auth), params.id, body.outcome, body.notes),
  }),
  defineRoute({
    method: 'patch', path: '/renewals/:id/status', tag: 'Renewals', summary: 'Close a renewal (needs a reason)',
    access: 'user', permission: 'renewal:manage', params: idParams,
    body: z.object({ status: z.literal('CLOSED'), reason: z.string().trim().min(1, 'A reason is required to close a renewal.').max(300) }),
    handler: ({ auth, params, body }) => closeRenewal(auth, orgIdOf(auth), params.id, body.reason),
  }),
];
