import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { idParams, objectId } from '../../lib/validators.js';
import { getPolicy, issuanceChecklist, issuePolicy, listPolicies } from './policies.service.js';

export const policyRoutes = [
  defineRoute({
    method: 'get', path: '/policies', tag: 'Policies', summary: 'Policies, optionally of one customer or one quotation',
    access: 'user', permission: 'policy:read', query: z.object({ customerId: objectId.optional(), quotationId: objectId.optional() }),
    handler: ({ auth, query }) => listPolicies(orgIdOf(auth), query),
  }),
  defineRoute({
    method: 'get', path: '/policies/:id', tag: 'Policies', summary: 'One policy',
    access: 'user', permission: 'policy:read', params: idParams,
    handler: ({ auth, params }) => getPolicy(orgIdOf(auth), params.id),
  }),
  defineRoute({
    method: 'get', path: '/policies/:id/issuance-checklist', tag: 'Policies', summary: 'What must be done before issuing',
    access: 'user', permission: 'policy:read', params: idParams,
    handler: ({ auth, params }) => issuanceChecklist(orgIdOf(auth), params.id),
  }),
  defineRoute({
    method: 'post', path: '/policies/:id/issue', tag: 'Policies', summary: 'Issue the policy (all checklist items must pass)',
    access: 'user', permission: 'policy:issue', params: idParams,
    handler: ({ auth, params }) => issuePolicy(auth, orgIdOf(auth), params.id),
  }),
];
