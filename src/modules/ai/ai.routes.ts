import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { objectId } from '../../lib/validators.js';
import { recommend } from './recommendations.service.js';

export const aiRoutes = [
  defineRoute({
    method: 'post', path: '/ai/recommendations', tag: 'AI', summary: 'Suitable products with reasons and warnings (Pro / Trial)',
    description: 'Eligibility filter + ranking + explanation from stored product data only.',
    access: 'user', permission: 'customer:read', feature: 'ai', body: z.object({ customerId: objectId }),
    handler: ({ auth, body }) => recommend(orgIdOf(auth), body.customerId),
  }),
];
