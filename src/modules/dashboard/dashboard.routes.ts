import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { dashboardSummary, kpiReport, pendingActions } from './dashboard.service.js';

export const dashboardRoutes = [
  defineRoute({
    method: 'get', path: '/dashboard/summary', tag: 'Dashboard', summary: 'Counts for the selected period (India time)',
    access: 'user', permission: 'dashboard:read', query: z.object({ range: z.enum(['today', '7d', '30d', 'month']).default('today') }),
    handler: ({ auth, query }) => dashboardSummary(orgIdOf(auth), query.range),
  }),
  defineRoute({
    method: 'get', path: '/dashboard/pending-actions', tag: 'Dashboard', summary: 'What needs attention now (most urgent first)',
    access: 'user', permission: 'dashboard:read', query: z.object({ limit: z.coerce.number().int().min(1).max(50).default(6) }),
    handler: ({ auth, query }) => pendingActions(orgIdOf(auth), query.limit),
  }),
  defineRoute({
    method: 'get', path: '/reports/kpis', tag: 'Dashboard', summary: 'Sales funnel and conversion rates (all time)',
    access: 'user', permission: 'report:read', feature: 'reports',
    handler: ({ auth }) => kpiReport(orgIdOf(auth)),
  }),
];
