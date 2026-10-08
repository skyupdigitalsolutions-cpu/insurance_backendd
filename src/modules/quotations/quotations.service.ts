import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { signedLink } from '../../lib/signedLinks.js';
import type { AuthContext } from '../../middleware/auth.js';
import { logEvent } from '../activities/activities.service.js';
import { audit } from '../audit/audit.service.js';
import { nextNumber } from '../counters/counter.model.js';
import { customerOrThrow } from '../customers/customers.service.js';
import { GST_RATES, calculatePricing } from '../products/pricing.js';
import { productOrThrow } from '../products/products.service.js';
import { Quotation, type QuotationDoc } from './quotation.model.js';

export type QuoteInput = {
  customerId: string; productId: string; addOnIds: string[]; frequency: 'Yearly' | 'Monthly';
  discountPercent: number; discountReason?: string | undefined; comparedProductIds: string[];
};

// Shape returned to the app (Quotation type) + a 15-minute PDF link
export const toQuotation = (q: QuotationDoc, baseUrl: string) => ({
  id: q._id.toString(),
  quoteNumber: q.quoteNumber,
  customerId: q.customerId.toString(),
  customerName: q.customerName,
  productId: q.productId.toString(),
  productName: q.product.name,
  companyName: q.product.companyName,
  type: q.product.type,
  addOnIds: q.addOns.map((a) => a.id),
  addOns: q.addOns,
  frequency: q.frequency,
  discountPercent: q.discountPercent,
  discountReason: q.discountReason ?? undefined,
  approvalStatus: q.approvalStatus,
  pricing: q.pricing,
  comparedProductIds: q.comparedProductIds,
  status: q.status,
  validUntil: q.validUntil,
  createdAt: q.createdAt,
  pdfUrl: signedLink(baseUrl, `/api/v1/quotations/${q._id.toString()}/pdf`, 'quote-pdf', q._id.toString()),
});

export async function quotationOrThrow(orgId: Types.ObjectId, id: string | Types.ObjectId): Promise<QuotationDoc> {
  const q = Types.ObjectId.isValid(id) ? await Quotation.findOne({ _id: id, orgId }).lean<QuotationDoc>() : null;
  if (!q) throw notFound('Quotation not found');
  return q;
}

const ageOn = (dob: string, at = new Date()) => {
  const d = new Date(`${dob}T00:00:00Z`);
  let age = at.getUTCFullYear() - d.getUTCFullYear();
  const m = at.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && at.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
};

async function priceFor(auth: AuthContext, orgId: Types.ObjectId, input: QuoteInput) {
  const [customer, product] = await Promise.all([customerOrThrow(orgId, input.customerId), productOrThrow(input.productId)]);
  if (input.discountPercent > 0 && !auth.permissions.includes('quotation:discount')) {
    throw forbidden('You are not allowed to give discounts.', 'NO_DISCOUNT_PERMISSION');
  }
  if (customer.dob && (product.minAge != null || product.maxAge != null)) {
    const age = ageOn(customer.dob);
    if ((product.minAge != null && age < product.minAge) || (product.maxAge != null && age > product.maxAge)) {
      throw badRequest(`Customer age ${age} is outside this product's eligibility (${product.eligibility ?? `${product.minAge ?? 0}–${product.maxAge ?? '…'}`}).`, 'NOT_ELIGIBLE');
    }
  }
  return { customer, product, ...calculatePricing(product, input) };
}

export async function calculate(auth: AuthContext, orgId: Types.ObjectId, input: QuoteInput) {
  const { pricing, needsApproval } = await priceFor(auth, orgId, input);
  return { pricing, needsApproval };
}

export async function listQuotations(orgId: Types.ObjectId, customerId: string | undefined, baseUrl: string) {
  const items = await Quotation.find({ orgId, ...(customerId ? { customerId } : {}) }).sort({ createdAt: -1, _id: -1 }).limit(200).lean<QuotationDoc[]>();
  return { items: items.map((q) => toQuotation(q, baseUrl)) };
}

export const getQuotation = async (orgId: Types.ObjectId, id: string, baseUrl: string) => toQuotation(await quotationOrThrow(orgId, id), baseUrl);

// Creates the quotation snapshot. Discounts above the advisor limit need someone with quotation:approve:
// if the caller has it and confirms (approveDiscount), it is approved now; otherwise it waits as DRAFT.
export async function createQuotation(auth: AuthContext, orgId: Types.ObjectId, input: QuoteInput & { approveDiscount: boolean }, baseUrl: string) {
  const { customer, product, pricing, selectedAddOns, needsApproval } = await priceFor(auth, orgId, input);
  if (!customer.consentGiven) throw badRequest("Record the customer's consent before creating a quotation.", 'CONSENT_REQUIRED');
  if (input.discountPercent > 0 && !input.discountReason) throw badRequest('Give a reason for the discount.', 'DISCOUNT_REASON_REQUIRED');

  const approveNow = needsApproval && input.approveDiscount && auth.permissions.includes('quotation:approve');
  const status = needsApproval && !approveNow ? 'DRAFT' : 'GENERATED';
  const q = await Quotation.create({
    orgId,
    quoteNumber: await nextNumber('Q', orgId),
    customerId: customer._id,
    customerName: customer.name,
    productId: product._id,
    productVersion: product.version,
    product: { name: product.name, companyName: product.companyName, type: product.type, coverage: product.coverage, features: product.features, exclusions: product.exclusions },
    addOns: selectedAddOns.map((a) => ({ id: a._id.toString(), name: a.name, premium: a.premium })),
    frequency: input.frequency,
    discountPercent: input.discountPercent,
    discountReason: input.discountReason ?? null,
    approvalStatus: needsApproval ? (approveNow ? 'APPROVED' : 'PENDING') : 'NONE',
    approvedBy: approveNow ? auth.userId : null,
    approvedAt: approveNow ? new Date() : null,
    pricing: { ...pricing, gstRate: GST_RATES[product.type] },
    comparedProductIds: input.comparedProductIds,
    status,
    validUntil: new Date(Date.now() + env.QUOTE_VALIDITY_DAYS * 86_400_000),
    createdBy: auth.userId,
  });
  await logEvent({ orgId, entityType: 'Customer', entityId: customer._id, actorUserId: auth.userId, text: `Quotation ${q.quoteNumber} for ${customer.name} – ${status === 'DRAFT' ? 'waiting for discount approval' : 'generated'}` });
  await audit({ orgId, actorUserId: auth.userId, action: 'quotation.create', entity: 'Quotation', entityId: q._id, meta: { total: pricing.total, discountPercent: input.discountPercent, status } });
  return toQuotation(q.toObject<QuotationDoc>(), baseUrl);
}

// Moves a quotation from one status to the next, only if nobody changed it in between
async function transition(orgId: Types.ObjectId, id: string, from: QuotationDoc['status'][], set: Record<string, unknown>) {
  const q = await Quotation.findOneAndUpdate({ _id: id, orgId, status: { $in: from } }, { $set: set }, { returnDocument: 'after' }).lean<QuotationDoc>();
  if (!q) throw conflict('This quotation was just changed. Refresh and try again.', 'STALE_QUOTATION');
  return q;
}

const assertNotExpired = (q: QuotationDoc) => {
  if (q.validUntil < new Date()) throw badRequest('This quotation has expired. Create a new one.', 'QUOTE_EXPIRED');
};

export async function approveQuotation(auth: AuthContext, orgId: Types.ObjectId, id: string, baseUrl: string) {
  const q = await quotationOrThrow(orgId, id);
  if (q.approvalStatus !== 'PENDING' || q.status !== 'DRAFT') throw badRequest('This quotation is not waiting for approval.', 'NOT_PENDING');
  const updated = await transition(orgId, id, ['DRAFT'], { status: 'GENERATED', approvalStatus: 'APPROVED', approvedBy: auth.userId, approvedAt: new Date() });
  await audit({ orgId, actorUserId: auth.userId, action: 'quotation.approve', entity: 'Quotation', entityId: q._id, meta: { discountPercent: q.discountPercent } });
  return toQuotation(updated, baseUrl);
}

export async function sendQuotation(auth: AuthContext, orgId: Types.ObjectId, id: string, channel: string, baseUrl: string) {
  const q = await quotationOrThrow(orgId, id);
  if (!['GENERATED', 'SENT'].includes(q.status)) {
    throw badRequest(q.status === 'DRAFT' ? 'The discount must be approved before sending.' : 'Only generated quotations can be sent.', 'CANNOT_SEND');
  }
  assertNotExpired(q);
  const updated = await transition(orgId, id, ['GENERATED', 'SENT'], { status: 'SENT', sentAt: new Date(), sentVia: channel });
  await logEvent({ orgId, entityType: 'Customer', entityId: q.customerId, actorUserId: auth.userId, text: `Quotation ${q.quoteNumber} sent to ${q.customerName} (${channel})` });
  return toQuotation(updated, baseUrl);
}

export async function acceptQuotation(auth: AuthContext, orgId: Types.ObjectId, id: string, baseUrl: string) {
  const q = await quotationOrThrow(orgId, id);
  if (q.status !== 'SENT') throw badRequest('Send the quotation to the customer before recording acceptance.', 'NOT_SENT');
  assertNotExpired(q);
  const updated = await transition(orgId, id, ['SENT'], { status: 'ACCEPTED', acceptedAt: new Date() });
  await logEvent({ orgId, entityType: 'Customer', entityId: q.customerId, actorUserId: auth.userId, text: `Quotation ${q.quoteNumber} accepted by ${q.customerName}` });
  await audit({ orgId, actorUserId: auth.userId, action: 'quotation.accept', entity: 'Quotation', entityId: q._id });
  return toQuotation(updated, baseUrl);
}
