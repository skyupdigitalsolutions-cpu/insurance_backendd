import { z } from 'zod';
import { defineRoute } from '../../lib/route.js';
import { idParams, listQuery, pagination } from '../../lib/validators.js';
import { JOB_NAMES } from '../../jobs/definitions.js';
import { USER_STATUSES } from '../users/user.model.js';
import { listAdvisors, listAudit, listJobs, overview, runJobNow } from './ops.service.js';
import { approveRegistration, listRegistrations, rejectRegistration } from './registrations.service.js';

// Used by the company's web admin panel (platform admins only)
export const adminRoutes = [
  defineRoute({
    method: 'get', path: '/admin/registrations', tag: 'Admin', summary: 'List advisor registrations (default: waiting for approval)',
    access: 'user', permission: 'platform:registration:approve',
    query: pagination.extend({ status: z.enum(USER_STATUSES).default('PENDING_VERIFICATION') }),
    handler: ({ query }) => listRegistrations(query),
  }),
  defineRoute({
    method: 'post', path: '/admin/registrations/:id/approve', tag: 'Admin', summary: 'Approve an advisor after KYC / IRDAI check',
    access: 'user', permission: 'platform:registration:approve', params: idParams,
    handler: ({ auth, params }) => approveRegistration(auth, params.id),
  }),
  defineRoute({
    method: 'post', path: '/admin/registrations/:id/reject', tag: 'Admin', summary: 'Reject an advisor registration',
    access: 'user', permission: 'platform:registration:approve', params: idParams,
    body: z.object({ reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500) }),
    handler: ({ auth, params, body }) => rejectRegistration(auth, params.id, body.reason),
  }),
  defineRoute({
    method: 'get', path: '/admin/overview', tag: 'Admin', summary: 'Platform numbers and system health (admin panel home)',
    access: 'user', permission: 'platform:ops:view',
    handler: () => overview(),
  }),
  defineRoute({
    method: 'get', path: '/admin/advisors', tag: 'Admin', summary: 'Advisors with plan, users, customers and active policies',
    access: 'user', permission: 'platform:ops:view', query: listQuery,
    handler: ({ query }) => listAdvisors(query),
  }),
  defineRoute({
    method: 'get', path: '/admin/audit', tag: 'Admin', summary: 'Audit log, newest first (filter by action prefix, e.g. "payment.")',
    access: 'user', permission: 'platform:ops:view',
    query: pagination.extend({ action: z.string().trim().max(60).optional() }),
    handler: ({ query }) => listAudit(query),
  }),
  defineRoute({
    method: 'get', path: '/admin/jobs', tag: 'Admin', summary: 'Background jobs: schedule, next run, last result, failures',
    access: 'user', permission: 'platform:ops:view',
    handler: () => listJobs(),
  }),
  defineRoute({
    method: 'post', path: '/admin/jobs/:name/run', tag: 'Admin', summary: 'Run a background job now (the worker picks it up)',
    access: 'user', permission: 'platform:jobs:run', status: 202,
    params: z.object({ name: z.enum(JOB_NAMES as [string, ...string[]]) }),
    handler: ({ auth, params }) => runJobNow(auth, params.name),
  }),
];
