import { Types } from 'mongoose';
import { todayInIndia } from '../../lib/dates.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/auth.js';
import { Activity, type ActivityDoc } from '../activities/activity.model.js';
import { logContact, logEvent } from '../activities/activities.service.js';
import { audit } from '../audit/audit.service.js';
import { Customer } from '../customers/customer.model.js';
import { Policy, type PolicyDoc } from '../policies/policy.model.js';
import { Quotation } from '../quotations/quotation.model.js';
import { RenewalState } from './renewal.model.js';

export type RenewalWindow = 'overdue' | '7d' | '30d' | 'all';
const LOOK_AHEAD_DAYS = 60; // "all" shows everything due in the next 60 days plus overdue

const daysUntil = (date: string) =>
  Math.round((new Date(`${date}T00:00:00Z`).getTime() - new Date(`${todayInIndia()}T00:00:00Z`).getTime()) / 86_400_000);

// Builds the renewals for a set of active policies with as few queries as possible
export async function buildRenewals(orgId: Types.ObjectId, policies: PolicyDoc[]) {
  if (!policies.length) return [];
  const customerIds = [...new Set(policies.map((p) => p.customerId.toString()))];
  const policyIds = policies.map((p) => p._id);
  const [customers, laterPolicies, laterQuotes, states, contacts] = await Promise.all([
    Customer.find({ _id: { $in: customerIds } }).lean(),
    Policy.find({ orgId, customerId: { $in: customerIds }, status: { $in: ['ACTIVE', 'PENDING_ISSUANCE'] } }).lean<PolicyDoc[]>(),
    Quotation.find({ orgId, customerId: { $in: customerIds } }).select('customerId product.name createdAt').lean(),
    RenewalState.find({ policyId: { $in: policyIds } }).lean(),
    Activity.find({ entityType: 'Policy', entityId: { $in: policyIds }, kind: 'CONTACT' }).sort({ at: -1 }).lean<ActivityDoc[]>(),
  ]);
  const customerById = new Map(customers.map((c) => [c._id.toString(), c]));
  const stateById = new Map(states.map((s) => [s.policyId.toString(), s]));

  return policies.map((pol) => {
    const c = customerById.get(pol.customerId.toString());
    const state = stateById.get(pol._id.toString());
    const daysLeft = daysUntil(pol.endDate ?? todayInIndia());
    const sameCover = (cust: Types.ObjectId, name: string) => cust.equals(pol.customerId) && name === pol.productName;
    // Renewed = a newer policy for the same customer and product; Quoted = a newer quotation for it
    const renewed = laterPolicies.some((p) => !p._id.equals(pol._id) && sameCover(p.customerId, p.productName) && p.createdAt > pol.createdAt);
    const quoted = laterQuotes.some((q) => sameCover(q.customerId, q.product?.name ?? '') && q.createdAt > pol.createdAt);
    const history = contacts.filter((a) => a.entityId.equals(pol._id));
    const status = renewed ? 'Renewed' : state?.closedReason ? 'Closed' : quoted ? 'Quoted'
      : daysLeft < 0 ? 'Overdue' : history.length ? 'Contacted' : 'Upcoming';
    return {
      id: pol._id.toString(),
      policyNumber: pol.policyNumber ?? '—',
      customerId: pol.customerId.toString(),
      customerName: pol.customerName,
      customerMobile: c?.mobile ?? '',
      productId: pol.productId.toString(),
      productName: pol.productName,
      companyName: pol.companyName,
      insurer: pol.companyName, // dashboard card
      premium: pol.premium,
      dueDate: pol.endDate ?? '',
      daysLeft,
      status,
      contacts: history.map((a) => ({ id: a._id.toString(), outcome: a.outcome ?? '', notes: a.notes ?? undefined, at: a.at })),
      closedReason: state?.closedReason ?? undefined,
    };
  });
}

export async function listRenewals(orgId: Types.ObjectId, window: RenewalWindow, limit: number) {
  const until = todayInIndia(window === '7d' ? 7 : window === '30d' ? 30 : window === 'overdue' ? -1 : LOOK_AHEAD_DAYS);
  const from = window === '7d' || window === '30d' ? todayInIndia() : undefined;
  const policies = await Policy.find({ orgId, status: 'ACTIVE', endDate: { $ne: null, $lte: until, ...(from ? { $gte: from } : {}) } })
    .sort({ endDate: 1 }).limit(500).lean<PolicyDoc[]>();
  let items = await buildRenewals(orgId, policies);
  if (window === 'overdue') items = items.filter((r) => r.status !== 'Renewed' && r.status !== 'Closed');
  return { items: items.slice(0, limit) };
}

async function renewalOrThrow(orgId: Types.ObjectId, policyId: string) {
  const pol = Types.ObjectId.isValid(policyId) ? await Policy.findOne({ _id: policyId, orgId }).lean<PolicyDoc>() : null;
  if (!pol) throw notFound('Policy not found');
  if (pol.status !== 'ACTIVE' || !pol.endDate) throw badRequest('This policy is not in the renewal workflow.', 'NOT_RENEWABLE');
  const [r] = await buildRenewals(orgId, [pol]);
  return { pol, renewal: r! };
}

export const getRenewal = async (orgId: Types.ObjectId, policyId: string) => (await renewalOrThrow(orgId, policyId)).renewal;

export async function logRenewalContact(auth: AuthContext, orgId: Types.ObjectId, policyId: string, outcome: string, notes?: string) {
  const { pol } = await renewalOrThrow(orgId, policyId);
  await logContact({ orgId, entityType: 'Policy', entityId: pol._id, actorUserId: auth.userId, type: 'Call', outcome, notes, text: `Renewal call with ${pol.customerName}: ${outcome}` });
  return getRenewal(orgId, policyId);
}

export async function closeRenewal(auth: AuthContext, orgId: Types.ObjectId, policyId: string, reason: string) {
  const { pol, renewal } = await renewalOrThrow(orgId, policyId);
  if (renewal.status === 'Renewed') throw badRequest('This policy is already renewed.', 'ALREADY_RENEWED');
  await RenewalState.updateOne(
    { policyId: pol._id },
    { $set: { orgId, closedReason: reason, closedAt: new Date(), closedBy: auth.userId } },
    { upsert: true },
  );
  await logEvent({ orgId, entityType: 'Policy', entityId: pol._id, actorUserId: auth.userId, text: `Renewal closed for ${pol.customerName}: ${reason}` });
  await audit({ orgId, actorUserId: auth.userId, action: 'renewal.close', entity: 'Policy', entityId: pol._id, meta: { reason } });
  return getRenewal(orgId, policyId);
}
