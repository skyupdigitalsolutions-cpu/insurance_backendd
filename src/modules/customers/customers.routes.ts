import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { idParams, indianMobile, listQuery, objectId, optionalEmail, optionalText, pastDate, personName, pinCode } from '../../lib/validators.js';
import {
  addFamily, addNominee, createCustomer, getCustomer, getNeed, listCustomers, listFamily, listNominees, recordConsent, removeNominee, saveNeed, updateCustomer,
} from './customers.service.js';
import { CONSENT_PURPOSES, INSURANCE_TYPES, RELATIONSHIPS } from './related.models.js';

const newCustomerInput = z.object({
  name: personName,
  mobile: indianMobile,
  email: optionalEmail,
  dob: pastDate.optional(),
  city: optionalText(60),
  pin: pinCode.optional(),
  source: optionalText(40),
  leadId: objectId.optional(),
});
const relationship = z.enum(RELATIONSHIPS, { message: 'Choose a relationship' });
const rupees = (label: string) => z.number({ message: `${label} must be a number` }).int().min(0, `${label} cannot be negative`).max(1_000_000_000);

export const customerRoutes = [
  defineRoute({
    method: 'get', path: '/customers', tag: 'Customers', summary: 'List / search customers (A–Z)',
    access: 'user', permission: 'customer:read', query: listQuery,
    handler: ({ auth, query }) => listCustomers(orgIdOf(auth), query),
  }),
  defineRoute({
    method: 'post', path: '/customers', tag: 'Customers', summary: 'Create a customer',
    access: 'user', permission: 'customer:create', body: newCustomerInput, status: 201,
    handler: ({ auth, body }) => createCustomer(auth, orgIdOf(auth), body),
  }),
  defineRoute({
    method: 'patch', path: '/customers/:id', tag: 'Customers', summary: 'Edit customer details',
    access: 'user', permission: 'customer:update', params: idParams,
    body: z.object({
      name: personName.optional(),
      mobile: indianMobile.optional(),
      email: optionalEmail,
      dob: pastDate.optional().nullable(),
      city: optionalText(60),
      pin: pinCode.optional().nullable(),
    }),
    handler: ({ auth, params, body }) => updateCustomer(orgIdOf(auth), params.id, body),
  }),
  defineRoute({
    method: 'get', path: '/customers/:id', tag: 'Customers', summary: 'One customer',
    access: 'user', permission: 'customer:read', params: idParams,
    handler: ({ auth, params }) => getCustomer(orgIdOf(auth), params.id),
  }),
  defineRoute({
    method: 'post', path: '/customers/:id/consents', tag: 'Customers', summary: 'Record customer consent (server time + who recorded it)',
    access: 'user', permission: 'customer:update', params: idParams, status: 201,
    body: z.object({ purpose: z.enum(CONSENT_PURPOSES).default('data-processing') }),
    handler: ({ auth, params, body, req }) =>
      recordConsent(auth, orgIdOf(auth), params.id, body.purpose, { ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null }),
  }),

  // ---- family ----
  defineRoute({
    method: 'get', path: '/customers/:id/family', tag: 'Customers', summary: 'Family members',
    access: 'user', permission: 'customer:read', params: idParams,
    handler: ({ auth, params }) => listFamily(orgIdOf(auth), params.id),
  }),
  defineRoute({
    method: 'post', path: '/customers/:id/family', tag: 'Customers', summary: 'Add a family member',
    access: 'user', permission: 'customer:update', params: idParams, status: 201,
    body: z.object({ name: personName, relationship, dob: pastDate.optional() }),
    handler: ({ auth, params, body }) => addFamily(auth, orgIdOf(auth), params.id, body),
  }),

  // ---- nominees ----
  defineRoute({
    method: 'get', path: '/customers/:id/nominees', tag: 'Customers', summary: 'Nominees',
    access: 'user', permission: 'customer:read', params: idParams,
    handler: ({ auth, params }) => listNominees(orgIdOf(auth), params.id),
  }),
  defineRoute({
    method: 'post', path: '/customers/:id/nominees', tag: 'Customers', summary: 'Add a nominee (total share ≤ 100 %)',
    access: 'user', permission: 'customer:update', params: idParams, status: 201,
    body: z.object({
      name: personName,
      relationship,
      percent: z.number({ message: 'Share must be a number' }).int('Share must be a whole number').min(1, 'Share must be at least 1%').max(100, 'Share cannot be more than 100%'),
    }),
    handler: ({ auth, params, body }) => addNominee(auth, orgIdOf(auth), params.id, body),
  }),
  defineRoute({
    method: 'delete', path: '/nominees/:id', tag: 'Customers', summary: 'Remove a nominee',
    access: 'user', permission: 'customer:update', params: idParams,
    handler: ({ auth, params }) => removeNominee(auth, orgIdOf(auth), params.id),
  }),

  // ---- need analysis ----
  defineRoute({
    method: 'get', path: '/customers/:id/need-analysis', tag: 'Customers', summary: 'Need analysis (null if not done yet)',
    access: 'user', permission: 'customer:read', params: idParams,
    handler: ({ auth, params }) => getNeed(orgIdOf(auth), params.id),
  }),
  defineRoute({
    method: 'put', path: '/customers/:id/need-analysis', tag: 'Customers', summary: 'Save need analysis',
    access: 'user', permission: 'customer:update', params: idParams,
    body: z.object({
      insuranceType: z.enum(INSURANCE_TYPES, { message: 'Choose an insurance type' }),
      need: z.string().trim().min(1, 'Describe the need').max(300),
      coverage: rupees('Coverage').optional(),
      budget: rupees('Budget').optional(),
      members: z.number().int().min(1, 'At least 1 member').max(20).optional(),
      notes: optionalText(1000),
    }),
    handler: ({ auth, params, body }) => saveNeed(auth, orgIdOf(auth), params.id, body),
  }),
];