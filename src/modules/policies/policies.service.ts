import { Types } from 'mongoose';
import { badRequest, notFound } from '../../lib/errors.js';
import { todayInIndia } from '../../lib/dates.js';
import type { AuthContext } from '../../middleware/auth.js';
import { logEvent } from '../activities/activities.service.js';
import { audit } from '../audit/audit.service.js';
import { nextNumber } from '../counters/counter.model.js';
import { Customer } from '../customers/customer.model.js';
import { CustomerDocument } from '../documents/document.model.js';
import { Payment } from '../payments/payment.model.js';
import { Quotation } from '../quotations/quotation.model.js';
import { Policy, type PolicyDoc } from './policy.model.js';

// Shape returned to the app (Policy type)
export const toPolicy = (p: PolicyDoc) => ({
  id: p._id.toString(),
  policyNumber: p.policyNumber ?? undefined,
  quotationId: p.quotationId.toString(),
  customerId: p.customerId.toString(),
  customerName: p.customerName,
  productName: p.productName,
  companyName: p.companyName,
  type: p.type,
  premium: p.premium,
  frequency: p.frequency,
  status: p.status,
  startDate: p.startDate ?? undefined,
  endDate: p.endDate ?? undefined,
  createdAt: p.createdAt,
});

async function policyOrThrow(orgId: Types.ObjectId, id: string): Promise<PolicyDoc> {
  const p = Types.ObjectId.isValid(id) ? await Policy.findOne({ _id: id, orgId }).lean<PolicyDoc>() : null;
  if (!p) throw notFound('Policy not found');
  return p;
}

export async function listPolicies(orgId: Types.ObjectId, filter: { customerId?: string | undefined; quotationId?: string | undefined }) {
  const items = await Policy.find({ orgId, ...(filter.customerId ? { customerId: filter.customerId } : {}), ...(filter.quotationId ? { quotationId: filter.quotationId } : {}) })
    .sort({ createdAt: -1, _id: -1 }).limit(200).lean<PolicyDoc[]>();
  return { items: items.map(toPolicy) };
}

export const getPolicy = async (orgId: Types.ObjectId, id: string) => toPolicy(await policyOrThrow(orgId, id));

// Everything that must be true before a policy can be issued (server-side interlock)
async function checklistFor(p: PolicyDoc) {
  const [payment, quote, customer, verifiedKyc] = await Promise.all([
    Payment.exists({ quotationId: p.quotationId, status: 'SUCCESS' }),
    Quotation.findById(p.quotationId).lean(),
    Customer.findById(p.customerId).lean(),
    CustomerDocument.exists({ customerId: p.customerId, status: 'Verified' }),
  ]);
  const nomineeTotal = customer?.nomineePercentTotal ?? 0;
  return [
    { key: 'payment', label: 'Payment verified', passed: !!payment, fixHint: 'Wait for payment confirmation' },
    { key: 'quote', label: 'Quotation accepted and paid', passed: quote?.status === 'PAID', fixHint: 'Quotation must be paid' },
    { key: 'customer', label: 'Customer date of birth recorded', passed: !!customer?.dob, fixHint: 'Add date of birth to the customer' },
    { key: 'consent', label: 'Customer consent recorded', passed: !!customer?.consentGiven, fixHint: 'Record consent on the customer screen' },
    { key: 'kyc', label: 'KYC document verified', passed: !!verifiedKyc, fixHint: 'Upload and verify a KYC document' },
    { key: 'nominee', label: 'Nominee allocation totals 100%', passed: nomineeTotal === 100, fixHint: `Current total is ${nomineeTotal}%` },
  ];
}

export async function issuanceChecklist(orgId: Types.ObjectId, id: string) {
  return { items: await checklistFor(await policyOrThrow(orgId, id)) };
}

export async function issuePolicy(auth: AuthContext, orgId: Types.ObjectId, id: string) {
  const p = await policyOrThrow(orgId, id);
  if (p.status === 'ACTIVE') return toPolicy(p); // issuing twice changes nothing
  const failed = (await checklistFor(p)).filter((i) => !i.passed);
  if (failed.length) throw badRequest(`Cannot issue: ${failed.map((f) => f.label).join(', ')}.`, 'CHECKLIST_FAILED');

  // One year cover: start today, end the day before the same date next year (Indian calendar)
  const startDate = todayInIndia();
  const end = new Date(`${startDate}T00:00:00Z`);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  const issued = await Policy.findOneAndUpdate(
    { _id: p._id, status: 'PENDING_ISSUANCE' },
    { $set: { status: 'ACTIVE', policyNumber: await nextNumber('POL', orgId), startDate, endDate: end.toISOString().slice(0, 10), issuedAt: new Date(), issuedBy: auth.userId } },
    { returnDocument: 'after' },
  ).lean<PolicyDoc>();
  if (!issued) return toPolicy(await policyOrThrow(orgId, id)); // issued by a parallel request
  await logEvent({ orgId, entityType: 'Customer', entityId: p.customerId, actorUserId: auth.userId, text: `Policy ${issued.policyNumber ?? ''} issued to ${p.customerName}` });
  await audit({ orgId, actorUserId: auth.userId, action: 'policy.issue', entity: 'Policy', entityId: p._id, meta: { policyNumber: issued.policyNumber } });
  return toPolicy(issued);
}
