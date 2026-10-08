import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { AuthContext } from '../../middleware/auth.js';
import { isDuplicateKeyError } from '../../middleware/error.js';
import { logEvent } from '../activities/activities.service.js';
import { audit } from '../audit/audit.service.js';
import { Customer } from '../customers/customer.model.js';
import { Policy } from '../policies/policy.model.js';
import { Quotation, type QuotationDoc } from '../quotations/quotation.model.js';
import { quotationOrThrow } from '../quotations/quotations.service.js';
import { applyCheckoutResult } from '../subscription/subscription.service.js';
import { Payment, PaymentEvent, type PaymentDoc } from './payment.model.js';
import { paymentProvider } from './provider.js';

// Shape returned to the app (Payment type)
export const toPayment = (p: PaymentDoc) => ({
  id: p._id.toString(),
  quotationId: p.quotationId.toString(),
  quoteNumber: p.quoteNumber,
  customerName: p.customerName,
  amount: p.amount,
  method: p.method,
  link: p.link ?? '',
  status: p.status,
  transactionRef: p.transactionRef ?? undefined,
  failureReason: p.failureReason ?? undefined,
  createdAt: p.createdAt,
  paidAt: p.paidAt ?? undefined,
});

// A link that ran out without payment counts as failed (Razorpay also sends payment_link.expired)
async function expireIfNeeded(p: PaymentDoc): Promise<PaymentDoc> {
  if (p.status !== 'PENDING' || !p.linkExpiresAt || p.linkExpiresAt > new Date()) return p;
  const updated = await Payment.findOneAndUpdate(
    { _id: p._id, status: 'PENDING' },
    { $set: { status: 'FAILED', failureReason: 'Payment link expired' } },
    { returnDocument: 'after' },
  ).lean<PaymentDoc>();
  return updated ?? p;
}

async function paymentOrThrow(orgId: Types.ObjectId, id: string): Promise<PaymentDoc> {
  const p = Types.ObjectId.isValid(id) ? await Payment.findOne({ _id: id, orgId }).lean<PaymentDoc>() : null;
  if (!p) throw notFound('Payment not found');
  return expireIfNeeded(p);
}

export async function listPayments(orgId: Types.ObjectId) {
  const items = await Payment.find({ orgId }).sort({ createdAt: -1, _id: -1 }).limit(200).lean<PaymentDoc[]>();
  return { items: (await Promise.all(items.map(expireIfNeeded))).map(toPayment) };
}

export const getPayment = async (orgId: Types.ObjectId, id: string) => toPayment(await paymentOrThrow(orgId, id));

async function newProviderLink(q: QuotationDoc, paymentId: Types.ObjectId) {
  const customer = await Customer.findById(q.customerId).lean();
  const expiresAt = new Date(Date.now() + env.PAYMENT_LINK_EXPIRY_HOURS * 3_600_000);
  const link = await paymentProvider.createLink({
    referenceId: paymentId.toString(),
    amountRupees: q.pricing.total,
    description: `${q.product.name} (${q.product.companyName}) – quotation ${q.quoteNumber}`,
    customer: { name: q.customerName, mobile: customer?.mobile ?? '', email: customer?.email ?? null },
    expiresAt,
  });
  return { ...link, expiresAt };
}

// Asks the provider for a payment link. Asking twice gives the same open payment (no double charge).
export async function createPaymentLink(auth: AuthContext, orgId: Types.ObjectId, quoteId: string, method: string) {
  const q = await quotationOrThrow(orgId, quoteId);
  const open = await Payment.findOne({ quotationId: q._id, status: 'PENDING' }).lean<PaymentDoc>();
  if (open) {
    const current = await expireIfNeeded(open);
    if (current.status === 'PENDING') return toPayment(current);
  }
  if (q.status === 'PAID') throw conflict('This quotation is already paid.', 'ALREADY_PAID');
  if (q.status !== 'ACCEPTED') throw badRequest('Payment can be requested only after the customer accepts.', 'NOT_ACCEPTED');
  if (q.validUntil < new Date()) throw badRequest('This quotation has expired. Create a new one.', 'QUOTE_EXPIRED');

  // Claim the quotation first: of two parallel taps only one creates a payment
  const claimed = await Quotation.updateOne({ _id: q._id, status: 'ACCEPTED' }, { $set: { status: 'PAYMENT_PENDING' } });
  if (claimed.modifiedCount !== 1) {
    const other = await Payment.findOne({ quotationId: q._id, status: 'PENDING' }).lean<PaymentDoc>();
    if (other) return toPayment(other);
    throw conflict('A payment link is being created. Try again in a moment.', 'PAYMENT_IN_PROGRESS');
  }

  const paymentId = new Types.ObjectId();
  try {
    const link = await newProviderLink(q, paymentId);
    const p = await Payment.create({
      _id: paymentId, orgId, quotationId: q._id, quoteNumber: q.quoteNumber, customerId: q.customerId, customerName: q.customerName,
      amount: q.pricing.total, method, provider: paymentProvider.name, providerLinkId: link.linkId, link: link.url,
      linkExpiresAt: link.expiresAt, attempts: [{ providerLinkId: link.linkId, link: link.url, createdAt: new Date(), outcome: 'OPEN' }],
      createdBy: auth.userId,
    });
    await logEvent({ orgId, entityType: 'Customer', entityId: q.customerId, actorUserId: auth.userId, text: `Payment link sent to ${q.customerName} for ${q.quoteNumber}` });
    await audit({ orgId, actorUserId: auth.userId, action: 'payment.link_create', entity: 'Payment', entityId: p._id, meta: { amount: p.amount, provider: p.provider } });
    return toPayment(p.toObject<PaymentDoc>());
  } catch (err) {
    await Quotation.updateOne({ _id: q._id, status: 'PAYMENT_PENDING' }, { $set: { status: 'ACCEPTED' } }); // undo the claim
    if (isDuplicateKeyError(err)) throw conflict('A payment link is being created. Try again in a moment.', 'PAYMENT_IN_PROGRESS');
    throw err;
  }
}

// After a failed or expired payment: same payment record, new link
export async function retryPayment(auth: AuthContext, orgId: Types.ObjectId, paymentId: string) {
  const p = await paymentOrThrow(orgId, paymentId);
  if (p.status !== 'FAILED') throw badRequest('Only failed payments can be retried.', 'NOT_FAILED');
  const q = await quotationOrThrow(orgId, p.quotationId);
  const link = await newProviderLink(q, new Types.ObjectId());
  const updated = await Payment.findOneAndUpdate(
    { _id: p._id, status: 'FAILED' },
    {
      $set: { status: 'PENDING', providerLinkId: link.linkId, link: link.url, linkExpiresAt: link.expiresAt, failureReason: null },
      $push: { attempts: { providerLinkId: link.linkId, link: link.url, createdAt: new Date(), outcome: 'OPEN' } },
    },
    { returnDocument: 'after' },
  ).lean<PaymentDoc>();
  if (!updated) throw conflict('This payment was just changed. Refresh and try again.', 'STALE_PAYMENT');
  await audit({ orgId, actorUserId: auth.userId, action: 'payment.retry', entity: 'Payment', entityId: p._id });
  return toPayment(updated);
}

// ---------- results from the provider (webhook or practice checkout) ----------
export type ProviderResult = {
  eventId: string;
  event: string;
  providerLinkId: string;
  outcome: 'PAID' | 'FAILED';
  amountPaise?: number;
  transactionRef?: string;
  reason?: string;
};

// Applies a provider result exactly once. Safe to call again with the same event (providers retry webhooks).
export async function applyProviderResult(r: ProviderResult): Promise<'applied' | 'duplicate' | 'ignored'> {
  try {
    await PaymentEvent.create({ eventId: r.eventId, provider: paymentProvider.name, event: r.event });
  } catch (err) {
    if (isDuplicateKeyError(err)) return 'duplicate';
    throw err;
  }
  // Also older links of the same payment (a customer may pay an old link after a retry)
  const p = await Payment.findOne({ $or: [{ providerLinkId: r.providerLinkId }, { 'attempts.providerLinkId': r.providerLinkId }] }).lean<PaymentDoc>();
  if (!p) {
    // Not a premium payment: maybe the advisor paying for their own plan
    const sub = await applyCheckoutResult(r);
    if (sub !== 'not_found') return sub;
    logger.warn({ providerLinkId: r.providerLinkId, event: r.event }, 'Payment event for an unknown link');
    return 'ignored';
  }
  await PaymentEvent.updateOne({ eventId: r.eventId }, { $set: { paymentId: p._id } });

  if (r.outcome === 'FAILED') {
    if (p.providerLinkId !== r.providerLinkId) return 'ignored'; // an old link expiring does not fail the current one
    const failed = await Payment.updateOne({ _id: p._id, status: 'PENDING' }, { $set: { status: 'FAILED', failureReason: r.reason ?? 'Payment failed' } });
    return failed.modifiedCount === 1 ? 'applied' : 'ignored';
  }

  // Never trust an amount we did not ask for
  if (r.amountPaise !== undefined && r.amountPaise !== Math.round(p.amount * 100)) {
    logger.error({ paymentId: p._id.toString(), expected: p.amount * 100, received: r.amountPaise }, 'Payment amount mismatch');
    await audit({ orgId: p.orgId, action: 'payment.amount_mismatch', entity: 'Payment', entityId: p._id, meta: { expectedPaise: p.amount * 100, receivedPaise: r.amountPaise } });
    return 'ignored';
  }
  const paid = await Payment.findOneAndUpdate(
    { _id: p._id, status: { $in: ['PENDING', 'FAILED'] } }, // a late success after "expired" still counts
    { $set: { status: 'SUCCESS', transactionRef: r.transactionRef ?? null, paidAt: new Date(), failureReason: null } },
    { returnDocument: 'after' },
  ).lean<PaymentDoc>();
  if (!paid) return 'ignored'; // already successful

  const q = await Quotation.findOneAndUpdate({ _id: p.quotationId }, { $set: { status: 'PAID' } }, { returnDocument: 'after' }).lean<QuotationDoc>();
  if (!q) throw new AppError(500, 'QUOTE_MISSING', 'Quotation missing for payment');
  try {
    await Policy.create({
      orgId: p.orgId, quotationId: q._id, paymentId: p._id, customerId: q.customerId, customerName: q.customerName,
      productId: q.productId, productName: q.product.name, companyName: q.product.companyName, type: q.product.type,
      premium: q.pricing.total, frequency: q.frequency,
    });
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err; // policy already created
  }
  await logEvent({ orgId: p.orgId, entityType: 'Customer', entityId: p.customerId, text: `Payment received from ${p.customerName} (${q.quoteNumber})` });
  await audit({ orgId: p.orgId, action: 'payment.success', entity: 'Payment', entityId: p._id, meta: { transactionRef: r.transactionRef, event: r.event } });
  return 'applied';
}
