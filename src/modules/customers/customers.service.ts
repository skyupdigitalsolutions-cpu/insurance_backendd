import type { Types } from 'mongoose';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { escapeRegex } from '../../lib/validators.js';
import type { AuthContext } from '../../middleware/auth.js';
import { isDuplicateKeyError } from '../../middleware/error.js';
import { logEvent } from '../activities/activities.service.js';
import { audit } from '../audit/audit.service.js';
import { Lead } from '../leads/lead.model.js';
import { Customer, type CustomerDoc } from './customer.model.js';
import {
  Consent, FamilyMember, NeedAnalysis, Nominee,
  type FamilyMemberDoc, type NeedAnalysisDoc, type NomineeDoc,
} from './related.models.js';

type Opt<T> = T | undefined;
export type NewCustomerInput = {
  _id?: Types.ObjectId; // pre-chosen id (lead conversion)
  name: string; mobile: string; email?: Opt<string>; dob?: Opt<string>; city?: Opt<string>; pin?: Opt<string>;
  source?: Opt<string>; leadId?: Opt<Types.ObjectId | string>;
};

// ---------- shapes returned to the app ----------
export const toCustomer = (c: CustomerDoc) => ({
  id: c._id.toString(),
  name: c.name,
  mobile: c.mobile,
  email: c.email ?? undefined,
  dob: c.dob ?? undefined,
  city: c.city ?? undefined,
  pin: c.pin ?? undefined,
  source: c.source,
  leadId: c.leadId?.toString(),
  consentGiven: c.consentGiven,
  consentAt: c.consentAt ?? undefined,
  createdAt: c.createdAt,
});
const toFamily = (f: FamilyMemberDoc) => ({ id: f._id.toString(), customerId: f.customerId.toString(), name: f.name, relationship: f.relationship, dob: f.dob ?? undefined });
const toNominee = (n: NomineeDoc) => ({ id: n._id.toString(), customerId: n.customerId.toString(), name: n.name, relationship: n.relationship, percent: n.percent });
const toNeed = (n: NeedAnalysisDoc) => ({
  customerId: n.customerId.toString(), insuranceType: n.insuranceType, need: n.need,
  coverage: n.coverage ?? undefined, budget: n.budget ?? undefined, members: n.members ?? undefined, notes: n.notes ?? undefined,
  updatedAt: n.updatedAt,
});

export async function customerOrThrow(orgId: Types.ObjectId, customerId: string | Types.ObjectId): Promise<CustomerDoc> {
  const c = await Customer.findOne({ _id: customerId, orgId }).lean<CustomerDoc>();
  if (!c) throw notFound('Customer not found');
  return c;
}

// ---------- customers ----------
export async function listCustomers(orgId: Types.ObjectId, query: { q: string; page: number; limit: number }) {
  const filter: Record<string, unknown> = { orgId };
  if (query.q) {
    const digits = query.q.replace(/\D/g, '');
    filter.$or = [{ name: new RegExp(escapeRegex(query.q), 'i') }, ...(digits.length >= 3 ? [{ mobile: new RegExp(escapeRegex(digits)) }] : [])];
  }
  const [items, total] = await Promise.all([
    Customer.find(filter).collation({ locale: 'en' }).sort({ name: 1, _id: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean<CustomerDoc[]>(),
    Customer.countDocuments(filter),
  ]);
  return { items: items.map(toCustomer), page: query.page, limit: query.limit, total };
}

export const getCustomer = async (orgId: Types.ObjectId, id: string) => toCustomer(await customerOrThrow(orgId, id));

// Used by "Create customer" and by lead conversion
export async function createCustomerRecord(auth: AuthContext, orgId: Types.ObjectId, input: NewCustomerInput) {
  if (input.leadId && !(await Lead.exists({ _id: input.leadId, orgId }))) throw badRequest('Lead not found', 'INVALID_LEAD');
  try {
    const customer = await Customer.create({
      ...(input._id ? { _id: input._id } : {}),
      orgId, name: input.name, mobile: input.mobile, email: input.email ?? null, dob: input.dob ?? null, city: input.city ?? null,
      pin: input.pin ?? null, source: input.source ?? 'Direct', leadId: input.leadId ?? null, createdBy: auth.userId,
    });
    await logEvent({ orgId, entityType: 'Customer', entityId: customer._id, actorUserId: auth.userId, text: `New customer: ${customer.name}` });
    await audit({ orgId, actorUserId: auth.userId, action: 'customer.create', entity: 'Customer', entityId: customer._id });
    return customer;
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('A customer with this mobile number already exists.', 'DUPLICATE_CUSTOMER');
    throw err;
  }
}

export const createCustomer = async (auth: AuthContext, orgId: Types.ObjectId, input: NewCustomerInput) =>
  toCustomer((await createCustomerRecord(auth, orgId, input)).toObject<CustomerDoc>());

export async function recordConsent(
  auth: AuthContext, orgId: Types.ObjectId, customerId: string, purpose: 'data-processing' | 'marketing',
  client: { ip?: string | null; userAgent?: string | null },
) {
  const customer = await customerOrThrow(orgId, customerId);
  const now = new Date();
  await Consent.create({ orgId, customerId: customer._id, purpose, givenAt: now, recordedBy: auth.userId, ip: client.ip ?? null, userAgent: client.userAgent?.slice(0, 300) ?? null });
  if (purpose === 'data-processing') {
    await Customer.updateOne({ _id: customer._id }, { $set: { consentGiven: true, consentAt: now } });
  }
  await logEvent({ orgId, entityType: 'Customer', entityId: customer._id, actorUserId: auth.userId, text: `Consent recorded for ${customer.name} (${purpose})` });
  await audit({ orgId, actorUserId: auth.userId, action: 'customer.consent', entity: 'Customer', entityId: customer._id, meta: { purpose } });
  return toCustomer(await customerOrThrow(orgId, customerId));
}

// ---------- family ----------
export async function listFamily(orgId: Types.ObjectId, customerId: string) {
  const c = await customerOrThrow(orgId, customerId);
  const items = await FamilyMember.find({ orgId, customerId: c._id }).sort({ createdAt: 1, _id: 1 }).lean<FamilyMemberDoc[]>();
  return { items: items.map(toFamily) };
}

export async function addFamily(auth: AuthContext, orgId: Types.ObjectId, customerId: string, input: { name: string; relationship: FamilyMemberDoc['relationship']; dob?: Opt<string> }) {
  const c = await customerOrThrow(orgId, customerId);
  if ((await FamilyMember.countDocuments({ customerId: c._id })) >= 20) throw badRequest('A customer can have at most 20 family members.', 'FAMILY_LIMIT');
  const f = await FamilyMember.create({ orgId, customerId: c._id, name: input.name, relationship: input.relationship, dob: input.dob ?? null });
  await audit({ orgId, actorUserId: auth.userId, action: 'family.add', entity: 'Customer', entityId: c._id, meta: { familyMemberId: f._id.toString() } });
  return toFamily(f.toObject<FamilyMemberDoc>());
}

// ---------- nominees ----------
export async function listNominees(orgId: Types.ObjectId, customerId: string) {
  const c = await customerOrThrow(orgId, customerId);
  const items = await Nominee.find({ orgId, customerId: c._id }).sort({ createdAt: 1, _id: 1 }).lean<NomineeDoc[]>();
  return { items: items.map(toNominee) };
}

export async function addNominee(auth: AuthContext, orgId: Types.ObjectId, customerId: string, input: { name: string; relationship: NomineeDoc['relationship']; percent: number }) {
  const c = await customerOrThrow(orgId, customerId);
  // Reserve the share atomically: two people adding nominees at once cannot push the total over 100 %
  const reserved = await Customer.updateOne(
    { _id: c._id, nomineePercentTotal: { $lte: 100 - input.percent } },
    { $inc: { nomineePercentTotal: input.percent } },
  );
  if (reserved.modifiedCount !== 1) {
    const total = (await customerOrThrow(orgId, customerId)).nomineePercentTotal + input.percent;
    throw badRequest(`Total allocation would be ${total}%. It cannot exceed 100%.`, 'NOMINEE_TOTAL');
  }
  try {
    const n = await Nominee.create({ orgId, customerId: c._id, ...input });
    await audit({ orgId, actorUserId: auth.userId, action: 'nominee.add', entity: 'Customer', entityId: c._id, meta: { nomineeId: n._id.toString(), percent: n.percent } });
    return toNominee(n.toObject<NomineeDoc>());
  } catch (err) {
    await Customer.updateOne({ _id: c._id }, { $inc: { nomineePercentTotal: -input.percent } }); // give the share back
    throw err;
  }
}

export async function removeNominee(auth: AuthContext, orgId: Types.ObjectId, nomineeId: string): Promise<void> {
  const n = await Nominee.findOneAndDelete({ _id: nomineeId, orgId }).lean<NomineeDoc>();
  if (!n) throw notFound('Nominee not found');
  await Customer.updateOne({ _id: n.customerId }, { $inc: { nomineePercentTotal: -n.percent } });
  await audit({ orgId, actorUserId: auth.userId, action: 'nominee.remove', entity: 'Customer', entityId: n.customerId, meta: { nomineeId, percent: n.percent } });
}

// ---------- need analysis ----------
export async function getNeed(orgId: Types.ObjectId, customerId: string) {
  const c = await customerOrThrow(orgId, customerId);
  const n = await NeedAnalysis.findOne({ orgId, customerId: c._id }).lean<NeedAnalysisDoc>();
  return n ? toNeed(n) : null; // null = not done yet (the app shows the empty form)
}

export async function saveNeed(
  auth: AuthContext, orgId: Types.ObjectId, customerId: string,
  input: { insuranceType: NeedAnalysisDoc['insuranceType']; need: string; coverage?: Opt<number>; budget?: Opt<number>; members?: Opt<number>; notes?: Opt<string> },
) {
  const c = await customerOrThrow(orgId, customerId);
  const n = await NeedAnalysis.findOneAndUpdate(
    { orgId, customerId: c._id },
    { $set: { insuranceType: input.insuranceType, need: input.need, coverage: input.coverage ?? null, budget: input.budget ?? null, members: input.members ?? null, notes: input.notes ?? null, updatedBy: auth.userId } },
    { upsert: true, returnDocument: 'after' },
  ).lean<NeedAnalysisDoc>();
  await audit({ orgId, actorUserId: auth.userId, action: 'need.save', entity: 'Customer', entityId: c._id });
  return toNeed(n);
}

export async function updateCustomer(
  orgId: Types.ObjectId, customerId: string,
  input: { name?: string; mobile?: string; email?: string | null; dob?: string | null; city?: string | null; pin?: string | null },
) {
  const c = await Customer.findOneAndUpdate(
    { _id: customerId, orgId },
    { $set: input },
    { returnDocument: 'after' },
  ).lean<CustomerDoc>();
  if (!c) throw notFound('Customer not found');
  return toCustomer(c);
}