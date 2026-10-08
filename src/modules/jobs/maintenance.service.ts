// Housekeeping jobs: expire old quotations and payment links, and catch payments whose webhook never arrived.
import { logger } from '../../lib/logger.js';
import { Payment, type PaymentDoc } from '../payments/payment.model.js';
import { applyProviderResult } from '../payments/payments.service.js';
import { paymentProvider } from '../payments/provider.js';
import { Quotation } from '../quotations/quotation.model.js';
import { SubscriptionCheckout, type CheckoutDoc } from '../subscription/subscription.model.js';
import { expireCheckouts } from '../subscription/subscription.service.js';

// Daily: quotations past their validity that the customer never accepted are closed as "Expired".
// Accepted / paid quotations are never touched (SRS §21 "only quotes past expiry and not paid/accepted").
export async function runExpireQuotes(now = new Date()) {
  const r = await Quotation.updateMany(
    { status: { $in: ['DRAFT', 'GENERATED', 'SENT'] }, validUntil: { $lt: now } },
    { $set: { status: 'CANCELLED', cancelReason: 'Expired' } },
  );
  logger.info({ expired: r.modifiedCount }, 'Expired quotations closed');
  return { expiredQuotes: r.modifiedCount };
}

// Every 15 minutes: links that ran out without payment become "failed" (the advisor can send a new link)
export async function runExpirePaymentLinks(now = new Date()) {
  const r = await Payment.updateMany(
    { status: 'PENDING', linkExpiresAt: { $lt: now } },
    { $set: { status: 'FAILED', failureReason: 'Payment link expired' } },
  );
  const checkouts = await expireCheckouts(now);
  logger.info({ payments: r.modifiedCount, checkouts }, 'Expired payment links closed');
  return { expiredPayments: r.modifiedCount, expiredPlanCheckouts: checkouts };
}

const MIN_AGE_MS = 10 * 60_000; // give the webhook 10 minutes before asking the provider ourselves
const MAX_PER_RUN = 100;

// Every 30 minutes (Razorpay only): asks the provider about open links, in case a webhook was lost.
// Results go through the same idempotent path as webhooks, so nothing is applied twice.
export async function runReconcilePayments(now = new Date()) {
  const summary = { checked: 0, paid: 0, closed: 0, errors: 0 };
  if (paymentProvider.name === 'mock') return summary;
  const olderThan = new Date(now.getTime() - MIN_AGE_MS);
  const recent = new Date(now.getTime() - 7 * 86_400_000);
  const [payments, checkouts] = await Promise.all([
    Payment.find({ status: 'PENDING', provider: paymentProvider.name, updatedAt: { $lte: olderThan, $gte: recent } }).limit(MAX_PER_RUN).lean<PaymentDoc[]>(),
    SubscriptionCheckout.find({ status: 'PENDING', provider: paymentProvider.name, createdAt: { $lte: olderThan, $gte: recent } }).limit(MAX_PER_RUN).lean<CheckoutDoc[]>(),
  ]);
  const linkIds = [...payments.map((p) => p.providerLinkId), ...checkouts.map((c) => c.providerLinkId)].filter((id): id is string => !!id);
  for (const linkId of linkIds) {
    summary.checked += 1;
    try {
      const state = await paymentProvider.fetchLink(linkId);
      if (!state || state.status === 'open') continue;
      const base = { eventId: `reconcile:${linkId}:${state.status}`, event: `reconcile.${state.status}`, providerLinkId: linkId };
      const result = state.status === 'paid'
        ? await applyProviderResult({ ...base, outcome: 'PAID', amountPaise: state.amountPaidPaise, ...(state.transactionRef ? { transactionRef: state.transactionRef } : {}) })
        : await applyProviderResult({ ...base, outcome: 'FAILED', reason: state.status === 'expired' ? 'Payment link expired' : 'Payment link cancelled' });
      if (result === 'applied') {
        if (state.status === 'paid') summary.paid += 1;
        else summary.closed += 1;
      }
    } catch (err) {
      summary.errors += 1;
      logger.warn({ err, linkId }, 'Could not reconcile payment link');
    }
  }
  logger.info(summary, 'Payment reconciliation done');
  return summary;
}
