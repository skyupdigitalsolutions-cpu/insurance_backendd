import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { safeEqualHex } from '../../lib/crypto.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { objectId } from '../../lib/validators.js';
import { applyDeliveryStatus, listMessages, listTemplates, previewMessage, sendMessage } from './communications.service.js';

// Only the part of Meta's webhook payload we use (delivery statuses)
const whatsappEvent = z.object({
  entry: z.array(z.object({
    changes: z.array(z.object({
      value: z.object({
        statuses: z.array(z.object({
          id: z.string(),
          status: z.string(),
          errors: z.array(z.object({ title: z.string().optional(), message: z.string().optional() })).optional(),
        })).optional(),
      }).loose(),
    }).loose()),
  }).loose()).default([]),
}).loose();

const target = z.object({ templateId: objectId, customerId: objectId });

export const communicationRoutes = [
  defineRoute({
    method: 'get', path: '/templates', tag: 'Communications', summary: 'Approved message templates',
    access: 'user', permission: 'communication:send', query: z.object({ status: z.enum(['approved']).default('approved') }),
    handler: ({ auth }) => listTemplates(orgIdOf(auth)),
  }),
  defineRoute({
    method: 'post', path: '/communications/preview', tag: 'Communications', summary: 'The message with the customer’s data filled in',
    access: 'user', permission: 'communication:send', body: target,
    handler: ({ auth, body }) => previewMessage(orgIdOf(auth), body.templateId, body.customerId),
  }),
  defineRoute({
    method: 'post', path: '/communications/send', tag: 'Communications', summary: 'Send a template message (WhatsApp needs consent, email needs an address)',
    access: 'user', permission: 'communication:send', body: z.object({ customerId: objectId, templateId: objectId }), status: 201,
    handler: ({ auth, body }) => sendMessage(auth, orgIdOf(auth), body.customerId, body.templateId),
  }),
  defineRoute({
    method: 'get', path: '/communications', tag: 'Communications', summary: 'Messages sent (newest first)',
    access: 'user', permission: 'communication:send',
    handler: ({ auth }) => listMessages(orgIdOf(auth)),
  }),
  // WhatsApp Cloud API delivery status (sent / delivered / read / failed). Meta first calls GET once to verify.
  defineRoute({
    method: 'get', path: '/webhooks/whatsapp', tag: 'Communications', summary: 'WhatsApp webhook verification (Meta calls this once)',
    access: 'public',
    query: z.object({ 'hub.mode': z.string().optional(), 'hub.verify_token': z.string().optional(), 'hub.challenge': z.string().optional() }),
    handler: ({ query, res }) => {
      if (env.WHATSAPP_PROVIDER !== 'meta' || !env.WHATSAPP_VERIFY_TOKEN) throw notFound();
      if (query['hub.mode'] !== 'subscribe' || query['hub.verify_token'] !== env.WHATSAPP_VERIFY_TOKEN) throw forbidden('Wrong verify token');
      res.type('text/plain').send(query['hub.challenge'] ?? '');
    },
  }),
  defineRoute({
    method: 'post', path: '/webhooks/whatsapp', tag: 'Communications', summary: 'WhatsApp delivery-status webhook (signed by Meta)',
    access: 'public',
    handler: async ({ req }) => {
      if (env.WHATSAPP_PROVIDER !== 'meta' || !env.WHATSAPP_APP_SECRET) throw notFound();
      const raw = req.rawBody;
      const signature = (req.get('x-hub-signature-256') ?? '').replace(/^sha256=/, '');
      const expected = createHmac('sha256', env.WHATSAPP_APP_SECRET).update(raw ?? Buffer.alloc(0)).digest('hex');
      if (!raw || !/^[a-f\d]{64}$/.test(signature) || !safeEqualHex(signature, expected)) throw badRequest('Invalid signature', 'BAD_SIGNATURE');
      const body = whatsappEvent.parse(req.body);
      let updated = 0;
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          for (const s of change.value.statuses ?? []) {
            const e = s.errors?.[0];
            if (await applyDeliveryStatus(s.id, s.status, e?.message ?? e?.title)) updated += 1;
          }
        }
      }
      return { updated }; // always 200 for a valid signature, so Meta does not keep retrying
    },
  }),
];
