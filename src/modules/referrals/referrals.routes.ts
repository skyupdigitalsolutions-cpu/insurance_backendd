import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { indianMobile, objectId, optionalText, personName } from '../../lib/validators.js';
import { createReferral, listReferrals } from './referrals.service.js';

export const referralRoutes = [
  defineRoute({
    method: 'get', path: '/referrals', tag: 'Referrals', summary: 'Referrals with live status from their lead',
    access: 'user', permission: 'referral:read',
    handler: ({ auth }) => listReferrals(orgIdOf(auth)),
  }),
  defineRoute({
    method: 'post', path: '/referrals', tag: 'Referrals', summary: 'Record a referral (creates a lead)',
    access: 'user', permission: 'referral:create', status: 201,
    body: z.object({
      referrerCustomerId: objectId.optional(),
      code: optionalText(20),
      name: personName,
      mobile: indianMobile,
      relationship: z.string().trim().min(1, 'Choose a relationship').max(40),
      interest: z.enum(['Health', 'Life', 'Motor'], { message: 'Choose an insurance type' }),
    }),
    handler: ({ auth, body }) => createReferral(auth, orgIdOf(auth), body),
  }),
];
