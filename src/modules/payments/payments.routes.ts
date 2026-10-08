import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { safeEqualHex } from '../../lib/crypto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { idParams } from '../../lib/validators.js';
import { applyProviderResult, createPaymentLink, getPayment, listPayments, retryPayment } from './payments.service.js';

// Razorpay webhook body (only the parts we use)
const razorpayEvent = z.object({
  event: z.string(),
  payload: z.object({
    payment_link: z.object({ entity: z.object({ id: z.string(), amount_paid: z.number().optional(), status: z.string().optional() }) }).optional(),
    payment: z.object({ entity: z.object({ id: z.string(), amount: z.number().optional() }) }).optional(),
  }),
});

export const paymentRoutes = [
  defineRoute({
    method: 'post', path: '/quotations/:id/payment-link', tag: 'Payments', summary: 'Create (or return the open) payment link',
    access: 'user', permission: 'payment:create', params: idParams, status: 201,
    body: z.object({ method: z.string().trim().min(1).max(40).default('Payment link') }),
    handler: ({ auth, params, body }) => createPaymentLink(auth, orgIdOf(auth), params.id, body.method),
  }),
  defineRoute({
    method: 'get', path: '/payments', tag: 'Payments', summary: 'Payments (newest first)',
    access: 'user', permission: 'payment:read',
    handler: ({ auth }) => listPayments(orgIdOf(auth)),
  }),
  defineRoute({
    method: 'get', path: '/payments/:id', tag: 'Payments', summary: 'One payment',
    access: 'user', permission: 'payment:read', params: idParams,
    handler: ({ auth, params }) => getPayment(orgIdOf(auth), params.id),
  }),
  defineRoute({
    method: 'post', path: '/payments/:id/retry', tag: 'Payments', summary: 'New link after a failed / expired payment',
    access: 'user', permission: 'payment:create', params: idParams,
    handler: ({ auth, params }) => retryPayment(auth, orgIdOf(auth), params.id),
  }),

  // Razorpay calls this. Only a correctly signed body is accepted; the same event twice is applied once.
  defineRoute({
    method: 'post', path: '/webhooks/razorpay', tag: 'Payments', summary: 'Razorpay webhook (payment_link.paid / expired / cancelled)',
    access: 'public',
    handler: async ({ req }) => {
      if (env.PAYMENT_PROVIDER !== 'razorpay' || !env.RAZORPAY_WEBHOOK_SECRET) throw notFound();
      const raw = req.rawBody;
      const signature = req.get('x-razorpay-signature') ?? '';
      const expected = createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(raw ?? Buffer.alloc(0)).digest('hex');
      if (!raw || !/^[a-f\d]{64}$/.test(signature) || !safeEqualHex(signature, expected)) throw badRequest('Invalid signature', 'BAD_SIGNATURE');

      const body = razorpayEvent.parse(req.body);
      const link = body.payload.payment_link?.entity;
      if (!link) return { status: 'ignored' };
      const eventId = req.get('x-razorpay-event-id') ?? `${body.event}:${link.id}:${body.payload.payment?.entity.id ?? ''}`;
      const base = { eventId, event: body.event, providerLinkId: link.id };
      let result: string = 'ignored';
      if (body.event === 'payment_link.paid') {
        result = await applyProviderResult({ ...base, outcome: 'PAID', amountPaise: link.amount_paid, transactionRef: body.payload.payment?.entity.id });
      } else if (body.event === 'payment_link.expired' || body.event === 'payment_link.cancelled') {
        result = await applyProviderResult({ ...base, outcome: 'FAILED', reason: body.event === 'payment_link.expired' ? 'Payment link expired' : 'Payment link cancelled' });
      }
      return { status: result }; // always 200 for a valid signature, so Razorpay does not retry forever
    },
  }),
];
