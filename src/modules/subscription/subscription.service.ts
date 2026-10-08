import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { formatDate, indianDateOf } from '../../lib/dates.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/auth.js';
import { audit } from '../audit/audit.service.js';
import { sms } from '../auth/sms.js';
import { claimReminder } from '../jobs/reminderLog.model.js';
import { nextNumber } from '../counters/counter.model.js';
import { Organization } from '../orgs/organization.model.js';
import { paymentProvider } from '../payments/provider.js';
import { User } from '../users/user.model.js';
import {
  FEATURE_NAMES, GRACE_DAYS, PLANS, SUBSCRIPTION_GST_RATE, TRIAL_DAYS, planById,
  type BillingCycle, type FeatureKey, type Plan, type PlanId,
} from './plans.js';
import { Invoice, Subscription, SubscriptionCheckout, type CheckoutDoc, type InvoiceDoc, type SubscriptionDoc } from './subscription.model.js';

const DAY = 86_400_000;

// Every organization has a subscription; older accounts get their trial from the registration date
export async function subscriptionOf(orgId: Types.ObjectId): Promise<SubscriptionDoc> {
  const existing = await Subscription.findOne({ orgId }).lean<SubscriptionDoc>();
  if (existing) return existing;
  const org = await Organization.findById(orgId).lean();
  const start = org?.trialStartedAt ?? new Date();
  return Subscription.findOneAndUpdate(
    { orgId },
    { $setOnInsert: { planId: 'trial', cycle: 'monthly', status: 'TRIAL', currentPeriodEnd: new Date(start.getTime() + TRIAL_DAYS * DAY), autoRenew: false } },
    { upsert: true, returnDocument: 'after' },
  ).lean<SubscriptionDoc>();
}

// TRIAL / ACTIVE / EXPIRED / CANCELLED as the app shows it
function effectiveStatus(s: SubscriptionDoc): 'TRIAL' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED' {
  const now = Date.now();
  if (s.status === 'TRIAL') return s.currentPeriodEnd.getTime() < now ? 'EXPIRED' : 'TRIAL';
  if (s.currentPeriodEnd.getTime() + GRACE_DAYS * DAY < now) return 'EXPIRED';
  return s.status;
}

export async function featuresOf(orgId: Types.ObjectId): Promise<{ plan: Plan; features: FeatureKey[]; status: string }> {
  const s = await subscriptionOf(orgId);
  const plan = planById(s.planId) ?? PLANS[0]!;
  const status = effectiveStatus(s);
  return { plan, status, features: status === 'EXPIRED' ? [] : plan.features };
}

// Used by routes marked with `feature`: the server checks the plan, not only the app
export async function requireFeature(orgId: Types.ObjectId, feature: FeatureKey): Promise<void> {
  const { features, status } = await featuresOf(orgId);
  if (!features.includes(feature)) {
    throw forbidden(
      status === 'EXPIRED'
        ? 'Your plan has expired. Renew it in Subscription to continue.'
        : `Your current plan doesn't include ${FEATURE_NAMES[feature]}. Upgrade to Pro to use it.`,
      'PLAN_FEATURE_MISSING',
    );
  }
}

async function isOwner(auth: AuthContext, orgId: Types.ObjectId) {
  const org = await Organization.findById(orgId).lean();
  return !!org?.ownerUserId?.equals(auth.userId);
}

const toInvoice = (i: InvoiceDoc) => ({
  id: i._id.toString(), number: i.number, planName: i.planName, cycle: i.cycle, amount: i.amount, gst: i.gst, total: i.total, paidAt: i.paidAt,
});

// Shape returned to the app (MySubscription)
export async function mySubscription(auth: AuthContext, orgId: Types.ObjectId) {
  const s = await subscriptionOf(orgId);
  const { plan, features, status } = await featuresOf(orgId);
  const invoices = await Invoice.find({ orgId }).sort({ paidAt: -1 }).limit(50).lean<InvoiceDoc[]>();
  return {
    plan,
    status,
    cycle: s.cycle,
    renewsAt: s.currentPeriodEnd.toISOString().slice(0, 10),
    daysLeft: Math.max(0, Math.ceil((s.currentPeriodEnd.getTime() - Date.now()) / DAY)),
    autoRenew: s.autoRenew,
    features,
    isOwner: await isOwner(auth, orgId),
    invoices: invoices.map(toInvoice),
  };
}

export const listPlans = () => ({ items: PLANS });

const toCheckout = (c: CheckoutDoc) => ({
  checkoutId: c._id.toString(), planName: planById(c.planId)?.name ?? c.planId, cycle: c.cycle,
  amount: c.amount, gst: c.gst, total: c.total, url: c.url, status: c.status,
});

// Creates a plan payment link for the account owner (used by the app and by the renewal reminder job)
async function createCheckout(input: {
  orgId: Types.ObjectId; ownerUserId: Types.ObjectId; plan: Plan; cycle: BillingCycle; expiresAt: Date; automatic: boolean;
}): Promise<CheckoutDoc> {
  const { orgId, plan, cycle } = input;
  const planId = plan.id;
  if (planId === 'trial') throw badRequest('Choose a paid plan.', 'INVALID_PLAN');
  const amount = cycle === 'monthly' ? plan.monthly : plan.yearly;
  const gst = Math.round(amount * SUBSCRIPTION_GST_RATE);
  const owner = await User.findById(input.ownerUserId).lean();
  if (!owner) throw notFound('Account owner not found');
  const checkoutId = new Types.ObjectId();
  const link = await paymentProvider.createLink({
    referenceId: checkoutId.toString(),
    amountRupees: amount + gst,
    description: `Insurance Advisor ${plan.name} plan (${cycle}) incl. 18% GST`,
    customer: { name: owner.name, mobile: owner.mobile, email: owner.email ?? null },
    expiresAt: input.expiresAt,
  });
  const c = await SubscriptionCheckout.create({
    _id: checkoutId, orgId, ownerUserId: owner._id, planId, cycle, amount, gst, total: amount + gst,
    provider: paymentProvider.name, providerLinkId: link.linkId, url: link.url, expiresAt: input.expiresAt, automatic: input.automatic,
  });
  return c.toObject<CheckoutDoc>();
}

// Starts a plan purchase; the app opens `url` (Razorpay, or the practice checkout in development)
export async function startCheckout(auth: AuthContext, orgId: Types.ObjectId, planId: PlanId, cycle: BillingCycle) {
  if (!(await isOwner(auth, orgId))) throw forbidden('Only the account owner can change the plan.', 'NOT_OWNER');
  const plan = planById(planId);
  if (!plan || plan.id === 'trial') throw badRequest('Choose a paid plan.', 'INVALID_PLAN');
  const s = await subscriptionOf(orgId);
  if (effectiveStatus(s) === 'ACTIVE' && s.planId === planId && s.cycle === cycle && s.currentPeriodEnd.getTime() - Date.now() > 7 * DAY) {
    throw badRequest('You are already on this plan.', 'SAME_PLAN');
  }
  const c = await createCheckout({ orgId, ownerUserId: auth.userId, plan, cycle, expiresAt: new Date(Date.now() + DAY), automatic: false });
  await audit({ orgId, actorUserId: auth.userId, action: 'subscription.checkout', entity: 'SubscriptionCheckout', entityId: c._id, meta: { planId, cycle, total: c.total } });
  return toCheckout(c);
}

export async function getCheckout(orgId: Types.ObjectId, checkoutId: string) {
  const c = await SubscriptionCheckout.findOne({ _id: checkoutId, orgId }).lean<CheckoutDoc>();
  if (!c) throw notFound('Checkout not found');
  return toCheckout(c);
}

export async function setAutoRenew(auth: AuthContext, orgId: Types.ObjectId, on: boolean) {
  if (!(await isOwner(auth, orgId))) throw forbidden('Only the account owner can change the plan.', 'NOT_OWNER');
  const s = await subscriptionOf(orgId);
  if (effectiveStatus(s) !== 'ACTIVE') throw badRequest('Auto-renew applies to paid plans only.', 'NOT_PAID_PLAN');
  await Subscription.updateOne({ _id: s._id }, { $set: { autoRenew: on } });
  return mySubscription(auth, orgId);
}

// Called with the provider's result for a plan checkout (same webhook / practice page as premiums).
// Returns false if the link is not a subscription checkout.
export async function applyCheckoutResult(r: {
  providerLinkId: string; outcome: 'PAID' | 'FAILED'; amountPaise?: number | undefined; transactionRef?: string | undefined;
}): Promise<'applied' | 'ignored' | 'not_found'> {
  const c = await SubscriptionCheckout.findOne({ providerLinkId: r.providerLinkId }).lean<CheckoutDoc>();
  if (!c) return 'not_found';
  if (r.outcome === 'FAILED') {
    const res = await SubscriptionCheckout.updateOne({ _id: c._id, status: 'PENDING' }, { $set: { status: 'FAILED' } });
    return res.modifiedCount ? 'applied' : 'ignored';
  }
  if (r.amountPaise !== undefined && r.amountPaise !== c.total * 100) return 'ignored';
  const paid = await SubscriptionCheckout.findOneAndUpdate(
    { _id: c._id, status: { $ne: 'PAID' } },
    { $set: { status: 'PAID', paidAt: new Date(), transactionRef: r.transactionRef ?? null } },
    { returnDocument: 'after' },
  ).lean<CheckoutDoc>();
  if (!paid) return 'ignored'; // already applied

  // New period starts today (or continues after the current paid period)
  const s = await subscriptionOf(c.orgId);
  const from = s.status === 'ACTIVE' && s.currentPeriodEnd.getTime() > Date.now() && s.planId === c.planId ? s.currentPeriodEnd.getTime() : Date.now();
  const end = new Date(from + (c.cycle === 'monthly' ? 30 : 365) * DAY);
  await Subscription.updateOne({ _id: s._id }, { $set: { planId: c.planId, cycle: c.cycle, status: 'ACTIVE', currentPeriodEnd: end, autoRenew: true } });
  await Invoice.create({
    orgId: c.orgId, number: await nextNumber('INV', 'platform'), checkoutId: c._id, planName: planById(c.planId)?.name ?? c.planId,
    cycle: c.cycle, amount: c.amount, gst: c.gst, total: c.total, paidAt: new Date(),
  });
  await audit({ orgId: c.orgId, action: 'subscription.activated', entity: 'SubscriptionCheckout', entityId: c._id, meta: { planId: c.planId, cycle: c.cycle, until: end } });
  return 'applied';
}

// Plan user limit (Basic: 1, Pro: 5)
export async function assertSeatAvailable(orgId: Types.ObjectId): Promise<void> {
  const { plan, status } = await featuresOf(orgId);
  const active = await User.countDocuments({ orgId, status: 'ACTIVE' });
  if (status === 'EXPIRED') throw forbidden('Your plan has expired. Renew it in Subscription to continue.', 'PLAN_EXPIRED');
  if (active >= plan.users) {
    throw forbidden(`Your plan allows ${plan.users} user${plan.users === 1 ? '' : 's'}. Upgrade to Pro to add more.`, 'USER_LIMIT');
  }
}

export async function createTrial(orgId: Types.ObjectId, start = new Date()) {
  await Subscription.updateOne(
    { orgId },
    { $setOnInsert: { planId: 'trial', cycle: 'monthly', status: 'TRIAL', currentPeriodEnd: new Date(start.getTime() + TRIAL_DAYS * DAY), autoRenew: false } },
    { upsert: true },
  );
}

// ---------- background jobs ----------
// Daily: paid plans with auto-renew get a payment link by SMS a few days before the renewal date;
// trials get a "your trial ends on …" SMS. Each reminder is sent once (ReminderLog key).
export async function runPlanReminders(now = new Date()) {
  const until = new Date(now.getTime() + env.PLAN_REMINDER_DAYS * DAY);
  const subs = await Subscription.find({ status: { $in: ['ACTIVE', 'TRIAL'] }, currentPeriodEnd: { $gt: now, $lte: until } }).lean<SubscriptionDoc[]>();
  const result = { renewalLinks: 0, trialReminders: 0, skipped: 0 };
  for (const s of subs) {
    const org = await Organization.findById(s.orgId).lean();
    const owner = org?.ownerUserId ? await User.findById(org.ownerUserId).lean() : null;
    const plan = planById(s.planId);
    if (!owner || owner.status !== 'ACTIVE' || !plan) { result.skipped += 1; continue; }
    const date = formatDate(indianDateOf(s.currentPeriodEnd));

    if (s.status === 'TRIAL') {
      if (!(await claimReminder(`trial:${s._id.toString()}`, s.orgId, 'trial', 'sms'))) continue;
      await sms.send(owner.mobile, 'trial_ending', { date });
      result.trialReminders += 1;
      continue;
    }
    if (!s.autoRenew) continue; // the owner switched reminders off
    if (!(await claimReminder(`plan:${s._id.toString()}:${indianDateOf(s.currentPeriodEnd)}`, s.orgId, 'plan', 'sms'))) continue;
    // The link keeps working through the grace days after the renewal date
    const c = await createCheckout({
      orgId: s.orgId, ownerUserId: owner._id, plan, cycle: s.cycle, automatic: true,
      expiresAt: new Date(s.currentPeriodEnd.getTime() + GRACE_DAYS * DAY),
    });
    await sms.send(owner.mobile, 'plan_renewal', { plan: plan.name, date, link: c.url });
    await audit({ orgId: s.orgId, action: 'subscription.renewal_link', entity: 'SubscriptionCheckout', entityId: c._id, meta: { planId: plan.id, cycle: s.cycle, total: c.total } });
    result.renewalLinks += 1;
  }
  return result;
}

// Plan payment links that ran out without payment
export async function expireCheckouts(now = new Date()) {
  const r = await SubscriptionCheckout.updateMany(
    { status: 'PENDING', $or: [{ expiresAt: { $lt: now } }, { expiresAt: null, createdAt: { $lt: new Date(now.getTime() - DAY) } }] },
    { $set: { status: 'FAILED' } },
  );
  return r.modifiedCount;
}
