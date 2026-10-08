import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { defineRoute } from '../../lib/route.js';
import { idParams, indianMobile, optionalEmail, optionalText, pagination, personName } from '../../lib/validators.js';
import { audit } from '../audit/audit.service.js';
import { ENQUIRY_STATUSES, Enquiry, type EnquiryDoc } from './enquiry.model.js';

const toEnquiry = (e: EnquiryDoc) => ({
  id: e._id.toString(), name: e.name, mobile: e.mobile, email: e.email, city: e.city, message: e.message, status: e.status, createdAt: e.createdAt,
});

export const enquiryRoutes = [
  // Website contact form. "website" is a hidden field people never fill in: bots do, and are quietly ignored.
  defineRoute({
    method: 'post', path: '/public/enquiries', tag: 'Website', summary: 'Contact form on the public website',
    access: 'public', limiter: 'register', status: 201,
    body: z.object({
      name: personName,
      mobile: indianMobile,
      email: optionalEmail,
      city: optionalText(60),
      message: z.string().trim().min(10, 'Tell us a little more (at least 10 characters)').max(1000),
      consent: z.literal(true, { error: 'Please agree to be contacted' }),
      website: z.string().max(200).optional(),
    }),
    handler: async ({ body, req }) => {
      if (body.website) return { received: true }; // honeypot: looks accepted, nothing stored
      await Enquiry.create({
        name: body.name, mobile: body.mobile, email: body.email ?? null, city: body.city ?? null, message: body.message,
        consentAt: new Date(), ip: req.ip ?? null,
      });
      return { received: true };
    },
  }),
  defineRoute({
    method: 'get', path: '/admin/enquiries', tag: 'Admin', summary: 'Website enquiries, newest first',
    access: 'user', permission: 'platform:ops:view',
    query: pagination.extend({ status: z.enum(ENQUIRY_STATUSES).optional() }),
    handler: async ({ query }) => {
      const filter = query.status ? { status: query.status } : {};
      const [rows, total] = await Promise.all([
        Enquiry.find(filter).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean<EnquiryDoc[]>(),
        Enquiry.countDocuments(filter),
      ]);
      return { items: rows.map(toEnquiry), page: query.page, limit: query.limit, total };
    },
  }),
  defineRoute({
    method: 'patch', path: '/admin/enquiries/:id', tag: 'Admin', summary: 'Mark an enquiry contacted or closed',
    access: 'user', permission: 'platform:ops:view', params: idParams,
    body: z.object({ status: z.enum(ENQUIRY_STATUSES) }),
    handler: async ({ auth, params, body }) => {
      const e = await Enquiry.findByIdAndUpdate(params.id, { $set: { status: body.status } }, { returnDocument: 'after' }).lean<EnquiryDoc>();
      if (!e) throw notFound('Enquiry not found');
      await audit({ orgId: null, actorUserId: auth.userId, action: 'enquiry.status', entity: 'Enquiry', entityId: e._id, meta: { status: body.status } });
      return toEnquiry(e);
    },
  }),
];
