import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { recentActivity } from './activities.service.js';

export const activityRoutes = [
  defineRoute({
    method: 'get', path: '/activities', tag: 'Activities', summary: 'Latest activity in my organization (dashboard)',
    access: 'user', permission: 'dashboard:read',
    query: z.object({ scope: z.enum(['recent']).default('recent'), limit: z.coerce.number().int().min(1).max(50).default(5) }),
    handler: ({ auth, query }) => recentActivity(orgIdOf(auth), query.limit),
  }),
];
