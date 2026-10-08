import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { idParams } from '../../lib/validators.js';
import { getCheckout, listPlans, mySubscription, setAutoRenew, startCheckout } from './subscription.service.js';

export const subscriptionRoutes = [
  defineRoute({
    method: 'get', path: '/subscription/plans', tag: 'Subscription', summary: 'Plans and prices (before 18% GST); public, shown during sign-up',
    access: 'public', limiter: 'publicRead',
    handler: () => listPlans(),
  }),
  defineRoute({
    method: 'get', path: '/subscription', tag: 'Subscription', summary: 'My plan, features, renewal date and invoices',
    access: 'user', permission: 'dashboard:read',
    handler: ({ auth }) => mySubscription(auth, orgIdOf(auth)),
  }),
  defineRoute({
    method: 'patch', path: '/subscription', tag: 'Subscription', summary: 'Turn auto-renew reminders on/off (owner only)',
    access: 'user', permission: 'dashboard:read', body: z.object({ autoRenew: z.boolean() }),
    handler: ({ auth, body }) => setAutoRenew(auth, orgIdOf(auth), body.autoRenew),
  }),
  defineRoute({
    method: 'post', path: '/subscription/checkout', tag: 'Subscription', summary: 'Start buying a plan (owner only); open the returned url',
    access: 'user', permission: 'dashboard:read', status: 201,
    body: z.object({ planId: z.enum(['basic', 'pro'], { message: 'Choose a paid plan.' }), cycle: z.enum(['monthly', 'yearly']) }),
    handler: ({ auth, body }) => startCheckout(auth, orgIdOf(auth), body.planId, body.cycle),
  }),
  defineRoute({
    method: 'get', path: '/subscription/checkout/:id', tag: 'Subscription', summary: 'Checkout status (the app polls this)',
    access: 'user', permission: 'dashboard:read', params: idParams,
    handler: ({ auth, params }) => getCheckout(orgIdOf(auth), params.id),
  }),
];
