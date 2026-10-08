import type { Request } from 'express';
import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { verifySignedLink } from '../../lib/signedLinks.js';
import { idParams, objectId, optionalText } from '../../lib/validators.js';
import { Organization } from '../orgs/organization.model.js';
import { User } from '../users/user.model.js';
import { Quotation, type QuotationDoc } from './quotation.model.js';
import { renderQuotationPdf } from './quotationPdf.js';
import { acceptQuotation, approveQuotation, calculate, createQuotation, getQuotation, listQuotations, sendQuotation } from './quotations.service.js';
import { MAX_DISCOUNT } from '../products/pricing.js';

const baseUrlOf = (req: Request) => `${req.protocol}://${req.get('host') ?? 'localhost'}`;

const quoteInput = z.object({
  customerId: objectId,
  productId: objectId,
  addOnIds: z.array(objectId).max(20).default([]),
  frequency: z.enum(['Yearly', 'Monthly']),
  discountPercent: z.number({ message: 'Discount must be a number' }).min(0, 'Discount cannot be negative').max(MAX_DISCOUNT, `Discount must be between 0% and ${MAX_DISCOUNT}%.`).default(0),
  discountReason: optionalText(300),
  comparedProductIds: z.array(objectId).max(3).default([]),
});

export const quotationRoutes = [
  defineRoute({
    method: 'post', path: '/quotations/calculate', tag: 'Quotations', summary: 'Price a quotation (nothing is saved)',
    access: 'user', permission: 'quotation:create', body: quoteInput,
    handler: ({ auth, body }) => calculate(auth, orgIdOf(auth), body),
  }),
  defineRoute({
    method: 'post', path: '/quotations', tag: 'Quotations', summary: 'Create the quotation snapshot',
    description: 'Discount above 10% is approved at once if approveDiscount=true and you have quotation:approve; otherwise it waits as DRAFT.',
    access: 'user', permission: 'quotation:create', status: 201,
    body: quoteInput.extend({ approveDiscount: z.boolean().default(false) }),
    handler: ({ auth, body, req }) => createQuotation(auth, orgIdOf(auth), body, baseUrlOf(req)),
  }),
  defineRoute({
    method: 'get', path: '/quotations', tag: 'Quotations', summary: 'Quotations (newest first), optionally of one customer',
    access: 'user', permission: 'quotation:read', query: z.object({ customerId: objectId.optional() }),
    handler: ({ auth, query, req }) => listQuotations(orgIdOf(auth), query.customerId, baseUrlOf(req)),
  }),
  defineRoute({
    method: 'get', path: '/quotations/:id', tag: 'Quotations', summary: 'One quotation (with a 15-minute PDF link)',
    access: 'user', permission: 'quotation:read', params: idParams,
    handler: ({ auth, params, req }) => getQuotation(orgIdOf(auth), params.id, baseUrlOf(req)),
  }),
  defineRoute({
    method: 'post', path: '/quotations/:id/approve', tag: 'Quotations', summary: 'Approve a discount above the advisor limit',
    access: 'user', permission: 'quotation:approve', params: idParams,
    handler: ({ auth, params, req }) => approveQuotation(auth, orgIdOf(auth), params.id, baseUrlOf(req)),
  }),
  defineRoute({
    method: 'post', path: '/quotations/:id/send', tag: 'Quotations', summary: 'Mark as sent to the customer',
    access: 'user', permission: 'quotation:create', params: idParams,
    body: z.object({ channel: z.enum(['WhatsApp', 'Email', 'Link', 'In person']).default('WhatsApp') }),
    handler: ({ auth, params, body, req }) => sendQuotation(auth, orgIdOf(auth), params.id, body.channel, baseUrlOf(req)),
  }),
  defineRoute({
    method: 'post', path: '/quotations/:id/accept', tag: 'Quotations', summary: 'Record that the customer accepted',
    access: 'user', permission: 'quotation:create', params: idParams,
    handler: ({ auth, params, req }) => acceptQuotation(auth, orgIdOf(auth), params.id, baseUrlOf(req)),
  }),
  defineRoute({
    method: 'get', path: '/quotations/:id/pdf', tag: 'Quotations', summary: 'Quotation PDF through a signed link',
    access: 'public', limiter: 'publicRead', params: idParams,
    query: z.object({ expires: z.coerce.number().int(), sig: z.string().max(64) }),
    handler: async ({ params, query, res }) => {
      verifySignedLink('quote-pdf', params.id, query.expires, query.sig);
      const q = await Quotation.findById(params.id).lean<QuotationDoc>();
      if (!q) throw new Error('Quotation disappeared');
      const [org, owner] = await Promise.all([Organization.findById(q.orgId).lean(), User.findById(q.createdBy).lean()]);
      const pdf = renderQuotationPdf(q, {
        agencyName: org?.name ?? 'Insurance Advisor', advisorName: owner?.name ?? '', mobile: owner?.mobile ?? '', irdaiNumber: org?.irdaiNumber ?? null,
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${q.quoteNumber}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      await new Promise<void>((resolve, reject) => {
        pdf.on('end', resolve).on('error', reject);
        pdf.pipe(res);
      });
    },
  }),
];
