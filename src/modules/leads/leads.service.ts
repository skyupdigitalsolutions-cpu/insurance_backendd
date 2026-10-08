import { Types } from 'mongoose';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { escapeRegex } from '../../lib/validators.js';
import type { AuthContext } from '../../middleware/auth.js';
import { isDuplicateKeyError } from '../../middleware/error.js';
import { Activity } from '../activities/activity.model.js';
import { logContact, logEvent, toLeadActivity } from '../activities/activities.service.js';
import { audit } from '../audit/audit.service.js';
import { Customer } from '../customers/customer.model.js';
import { createCustomerRecord, toCustomer } from '../customers/customers.service.js';
import { ReferralCode } from '../referrals/referralCode.model.js';
import { Lead, type LeadDoc, type LeadStatus } from './lead.model.js';
import { CONVERTIBLE, LEAD_TRANSITIONS } from './leadStatus.js';

export type NewLeadInput = {
  name: string; mobile: string; email?: string | undefined; source: LeadDoc['source'];
  referralCode?: string | undefined; campaign?: string | undefined; requirement?: string | undefined; notes?: string | undefined;
};

// Shape returned to the app (Lead type)
export async function toLead(lead: LeadDoc, withActivities = true) {
  const activities = withActivities
    ? await Activity.find({ entityType: 'Lead', entityId: lead._id, kind: 'CONTACT' }).sort({ at: -1, _id: -1 }).limit(50).lean()
    : [];
  return {
    id: lead._id.toString(),
    name: lead.name,
    mobile: lead.mobile,
    email: lead.email ?? undefined,
    source: lead.source,
    referralCode: lead.referralCode ?? undefined,
    campaign: lead.campaign ?? undefined,
    requirement: lead.requirement ?? undefined,
    notes: lead.notes ?? undefined,
    status: lead.status,
    lostReason: lead.lostReason ?? undefined,
    customerId: lead.customerId?.toString(),
    createdAt: lead.createdAt,
    activities: activities.map(toLeadActivity),
  };
}

async function leadOrThrow(orgId: Types.ObjectId, leadId: string): Promise<LeadDoc> {
  const lead = await Lead.findOne({ _id: leadId, orgId }).lean<LeadDoc>();
  if (!lead) throw notFound('Lead not found');
  return lead;
}

export async function listLeads(orgId: Types.ObjectId, query: { q: string; status?: LeadStatus | undefined; page: number; limit: number }) {
  const filter: Record<string, unknown> = { orgId };
  if (query.status) filter.status = query.status;
  if (query.q) {
    const text = new RegExp(escapeRegex(query.q), 'i');
    const digits = query.q.replace(/\D/g, '');
    filter.$or = [{ name: text }, ...(digits.length >= 3 ? [{ mobile: new RegExp(escapeRegex(digits)) }] : [])];
  }
  const [leads, total] = await Promise.all([
    Lead.find(filter).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean<LeadDoc[]>(),
    Lead.countDocuments(filter),
  ]);
  return { items: await Promise.all(leads.map((l) => toLead(l, false))), page: query.page, limit: query.limit, total };
}

export async function getLead(orgId: Types.ObjectId, leadId: string) {
  const lead = await leadOrThrow(orgId, leadId);
  return { ...(await toLead(lead)), allowedTransitions: LEAD_TRANSITIONS[lead.status] };
}

export async function findDuplicate(orgId: Types.ObjectId, mobile: string) {
  const lead = await Lead.findOne({ orgId, mobile }).lean<LeadDoc>();
  return { match: lead ? await toLead(lead, false) : null };
}

export async function createLead(auth: AuthContext, orgId: Types.ObjectId, input: NewLeadInput) {
  let referralCode: string | null = null;
  if (input.source === 'Referral') {
    if (!input.referralCode) throw badRequest('Enter the referral code.', 'REFERRAL_CODE_REQUIRED');
    referralCode = input.referralCode.toUpperCase();
    if (!(await ReferralCode.exists({ orgId, code: referralCode, active: true }))) {
      throw badRequest('Referral code is not active.', 'REFERRAL_CODE_INACTIVE');
    }
  }
  try {
    const lead = await Lead.create({
      orgId, name: input.name, mobile: input.mobile, email: input.email ?? null, source: input.source, referralCode,
      campaign: input.source === 'Campaign' ? input.campaign ?? null : null,
      requirement: input.requirement ?? null, notes: input.notes ?? null, createdBy: auth.userId,
    });
    await logEvent({ orgId, entityType: 'Lead', entityId: lead._id, actorUserId: auth.userId, text: `New lead: ${lead.name} (${lead.source})` });
    await audit({ orgId, actorUserId: auth.userId, action: 'lead.create', entity: 'Lead', entityId: lead._id });
    return toLead(lead.toObject<LeadDoc>());
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('A lead with this mobile number already exists.', 'DUPLICATE_LEAD');
    throw err;
  }
}

export async function changeStatus(auth: AuthContext, orgId: Types.ObjectId, leadId: string, status: LeadStatus, reason?: string) {
  const lead = await leadOrThrow(orgId, leadId);
  if (!LEAD_TRANSITIONS[lead.status].includes(status)) {
    throw badRequest(`Cannot move lead from ${lead.status} to ${status}.`, 'INVALID_TRANSITION');
  }
  if (status === 'LOST' && !reason) throw badRequest('A reason is required to mark a lead as lost.', 'REASON_REQUIRED');

  // Only succeeds if nobody changed the status in the meantime
  const updated = await Lead.findOneAndUpdate(
    { _id: lead._id, orgId, status: lead.status },
    { $set: { status, lostReason: status === 'LOST' ? reason : null } },
    { returnDocument: 'after' },
  ).lean<LeadDoc>();
  if (!updated) throw conflict('This lead was just changed by someone else. Refresh and try again.', 'STALE_LEAD');

  const label = status === 'NEW' ? 'reopened' : `${lead.status} → ${status}`;
  await logEvent({ orgId, entityType: 'Lead', entityId: lead._id, actorUserId: auth.userId, text: `Lead ${lead.name}: ${label}${status === 'LOST' ? ` (${reason})` : ''}` });
  await audit({ orgId, actorUserId: auth.userId, action: 'lead.status', entity: 'Lead', entityId: lead._id, meta: { from: lead.status, to: status, reason } });
  return toLead(updated);
}

export async function addActivity(
  auth: AuthContext, orgId: Types.ObjectId, leadId: string,
  input: { type: 'Call' | 'WhatsApp' | 'Email' | 'Meeting'; outcome: string; notes?: string | undefined },
) {
  const lead = await leadOrThrow(orgId, leadId);
  if (lead.status === 'CONVERTED') throw badRequest('This lead is already converted. Add notes on the customer instead.', 'LEAD_CLOSED');
  await logContact({ orgId, entityType: 'Lead', entityId: lead._id, actorUserId: auth.userId, ...input, text: `${input.type} with ${lead.name}: ${input.outcome}` });
  // First contact moves a NEW lead to CONTACTED
  await Lead.updateOne({ _id: lead._id, status: 'NEW' }, { $set: { status: 'CONTACTED' } });
  return toLead(await leadOrThrow(orgId, leadId));
}

// Creates (or links) the customer for a qualified lead
export async function convertLead(auth: AuthContext, orgId: Types.ObjectId, leadId: string) {
  const lead = await leadOrThrow(orgId, leadId);
  if (lead.customerId) throw conflict('This lead is already converted.', 'ALREADY_CONVERTED');
  if (!CONVERTIBLE.includes(lead.status)) throw badRequest('Qualify the lead before converting it to a customer.', 'NOT_QUALIFIED');

  // 1. Claim the lead first (atomic): of two parallel requests only one gets past this point
  const existing = await Customer.findOne({ orgId, mobile: lead.mobile });
  const customerId = existing?._id ?? new Types.ObjectId();
  const claimed = await Lead.updateOne({ _id: lead._id, customerId: null }, { $set: { customerId } });
  if (claimed.modifiedCount !== 1) throw conflict('This lead is already converted.', 'ALREADY_CONVERTED');

  // 2. Create the customer (unless one with this mobile already existed)
  let customer = existing;
  if (!customer) {
    try {
      customer = await createCustomerRecord(auth, orgId, {
        _id: customerId, name: lead.name, mobile: lead.mobile, email: lead.email ?? undefined, source: lead.source, leadId: lead._id,
      });
    } catch (err) {
      // Someone created a customer with this mobile a moment ago: link to that one instead
      const other = await Customer.findOne({ orgId, mobile: lead.mobile });
      if (!other) {
        await Lead.updateOne({ _id: lead._id, customerId }, { $set: { customerId: null } }); // undo the claim
        throw err;
      }
      await Lead.updateOne({ _id: lead._id }, { $set: { customerId: other._id } });
      customer = other;
    }
  }
  await logEvent({ orgId, entityType: 'Lead', entityId: lead._id, actorUserId: auth.userId, text: `Lead ${lead.name} converted to customer` });
  await audit({ orgId, actorUserId: auth.userId, action: 'lead.convert', entity: 'Lead', entityId: lead._id, meta: { customerId: customer._id.toString(), reusedCustomer: !!existing } });
  return toCustomer(customer.toObject());
}

export async function updateLead(
  orgId: Types.ObjectId, leadId: string,
  input: { name?: string; mobile?: string; email?: string | null; source?: string; requirement?: string | null; notes?: string | null },
) {
  const lead = await Lead.findOneAndUpdate(
    { _id: leadId, orgId },
    { $set: input },
    { returnDocument: 'after' },
  ).lean<LeadDoc>();
  if (!lead) throw notFound('Lead not found');
  return toLead(lead, false);
}