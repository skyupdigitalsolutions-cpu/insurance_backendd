import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { idParams, indianMobile, listQuery, optionalEmail, optionalText, personName } from '../../lib/validators.js';
import { CONTACT_TYPES } from '../activities/activity.model.js';
import { LEAD_SOURCES, LEAD_STATUSES } from './lead.model.js';
import { addActivity, changeStatus, convertLead, createLead, findDuplicate, getLead, listLeads, updateLead } from './leads.service.js';

const newLeadInput = z.object({
  name: personName,
  mobile: indianMobile,
  email: optionalEmail,
  source: z.enum(LEAD_SOURCES, { message: 'Choose a source' }),
  referralCode: optionalText(20),
  campaign: optionalText(80),
  requirement: optionalText(300),
  notes: optionalText(1000),
});

export const leadRoutes = [
  defineRoute({
    method: 'get', path: '/leads', tag: 'Leads', summary: 'List / search leads (newest first)',
    access: 'user', permission: 'lead:read', query: listQuery.extend({ status: z.enum(LEAD_STATUSES).optional() }),
    handler: ({ auth, query }) => listLeads(orgIdOf(auth), query),
  }),
  defineRoute({
    method: 'post', path: '/leads/duplicate-check', tag: 'Leads', summary: 'Is there already a lead with this mobile?',
    access: 'user', permission: 'lead:read', body: z.object({ mobile: indianMobile }),
    handler: ({ auth, body }) => findDuplicate(orgIdOf(auth), body.mobile),
  }),
  defineRoute({
    method: 'post', path: '/leads', tag: 'Leads', summary: 'Create a lead',
    access: 'user', permission: 'lead:create', body: newLeadInput, status: 201,
    handler: ({ auth, body }) => createLead(auth, orgIdOf(auth), body),
  }),
  defineRoute({
    method: 'get', path: '/leads/:id', tag: 'Leads', summary: 'Lead with contact history and allowed next statuses',
    access: 'user', permission: 'lead:read', params: idParams,
    handler: ({ auth, params }) => getLead(orgIdOf(auth), params.id),
  }),
  defineRoute({
    method: 'patch', path: '/leads/:id', tag: 'Leads', summary: 'Edit lead details',
    access: 'user', permission: 'lead:update', params: idParams,
    body: z.object({
      name: personName.optional(),
      mobile: indianMobile.optional(),
      email: optionalEmail,
      source: z.enum(LEAD_SOURCES).optional(),
      requirement: optionalText(300),
      notes: optionalText(1000),
    }),
    handler: ({ auth, params, body }) => updateLead(orgIdOf(auth), params.id, body),
  }),
  defineRoute({
    method: 'patch', path: '/leads/:id/status', tag: 'Leads', summary: 'Change lead status (state machine; LOST needs a reason)',
    access: 'user', permission: 'lead:update', params: idParams,
    body: z.object({ status: z.enum(LEAD_STATUSES), reason: optionalText(300) }),
    handler: ({ auth, params, body }) => changeStatus(auth, orgIdOf(auth), params.id, body.status, body.reason),
  }),
  defineRoute({
    method: 'post', path: '/leads/:id/activities', tag: 'Leads', summary: 'Log a call / WhatsApp / email / meeting',
    access: 'user', permission: 'lead:update', params: idParams, status: 201,
    body: z.object({
      type: z.enum(CONTACT_TYPES),
      outcome: z.string().trim().min(1, 'Choose an outcome').max(60),
      notes: optionalText(1000),
    }),
    handler: ({ auth, params, body }) => addActivity(auth, orgIdOf(auth), params.id, body),
  }),
  defineRoute({
    method: 'post', path: '/leads/:id/convert', tag: 'Leads', summary: 'Convert a qualified lead to a customer',
    access: 'user', permission: 'lead:update', params: idParams, status: 201,
    handler: ({ auth, params }) => convertLead(auth, orgIdOf(auth), params.id),
  }),
];