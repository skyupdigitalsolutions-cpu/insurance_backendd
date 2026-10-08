import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { objectId, optionalText } from '../../lib/validators.js';
import { CALL_OUTCOMES } from './callLog.model.js';
import { listCalls, logCall, queue } from './autodial.service.js';

export const autodialRoutes = [
  defineRoute({
    method: 'get', path: '/autodial/queue', tag: 'Autodial', summary: 'Contacts to call for a list (Pro / Trial)',
    access: 'user', permission: 'lead:read', feature: 'autodial',
    query: z.object({ list: z.enum(['new_leads', 'open_leads', 'renewals']) }),
    handler: ({ auth, query }) => queue(orgIdOf(auth), query.list),
  }),
  defineRoute({
    method: 'post', path: '/autodial/calls', tag: 'Autodial', summary: 'Save a call outcome (on the lead or renewal; "Call back" adds a task)',
    access: 'user', permission: 'lead:read', feature: 'autodial', status: 201,
    body: z.object({
      kind: z.enum(['lead', 'renewal']),
      refId: objectId,
      outcome: z.enum(CALL_OUTCOMES, { message: 'Choose an outcome' }),
      notes: optionalText(1000),
      durationSec: z.number().int().min(0).max(4 * 3600).default(0),
    }),
    handler: ({ auth, body }) => logCall(auth, orgIdOf(auth), body),
  }),
  defineRoute({
    method: 'get', path: '/autodial/calls', tag: 'Autodial', summary: 'Recent calls',
    access: 'user', permission: 'lead:read', feature: 'autodial',
    handler: ({ auth }) => listCalls(orgIdOf(auth)),
  }),
];
