// Part 5: background jobs (reminders, plan renewal links, expiry). The job functions are called directly;
// the queue/worker wiring is tested in admin-ops.test.ts.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { todayInIndia } from '../src/lib/dates.js';
import { sms } from '../src/modules/auth/sms.js';
import { Message } from '../src/modules/communications/communication.models.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { runExpirePaymentLinks, runExpireQuotes } from '../src/modules/jobs/maintenance.service.js';
import { runBirthdayWishes, runPaymentReminders, runRenewalReminders } from '../src/modules/jobs/reminders.service.js';
import { Payment } from '../src/modules/payments/payment.model.js';
import { Policy } from '../src/modules/policies/policy.model.js';
import { Quotation } from '../src/modules/quotations/quotation.model.js';
import { RenewalState } from '../src/modules/renewals/renewal.model.js';
import { Subscription, SubscriptionCheckout } from '../src/modules/subscription/subscription.model.js';
import { applyCheckoutResult, runPlanReminders } from '../src/modules/subscription/subscription.service.js';
import { Task } from '../src/modules/tasks/task.model.js';
import { User } from '../src/modules/users/user.model.js';
import {
  DEMO, V1, api, bearer, closeConnections, customerId, demoOrgId, productId, registerAdvisor, resetDatabase, setDemoPlan, tokenOf,
} from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

const DAY = 86_400_000;
const setEndDate = (policyNumber: string, inDays: number) => Policy.updateOne({ policyNumber }, { $set: { endDate: todayInIndia(inDays) } });
const autoMessages = () => Message.find({ automatic: true }).sort({ createdAt: 1 }).lean();

async function newQuote(token: string, opts: { accept?: boolean } = {}) {
  const q = await api().post(`${V1}/quotations`).set(bearer(token)).send({
    customerId: await customerId('Ravi Kumar'), productId: await productId('Car Secure Comprehensive'),
    addOnIds: [], frequency: 'Yearly', discountPercent: 0, comparedProductIds: [],
  });
  expect(q.status, JSON.stringify(q.body)).toBe(201);
  if (opts.accept) {
    await api().post(`${V1}/quotations/${q.body.id}/send`).set(bearer(token)).send({});
    await api().post(`${V1}/quotations/${q.body.id}/accept`).set(bearer(token));
  }
  return q.body as { id: string; quoteNumber: string };
}

describe('Renewal reminders', () => {
  it('Pro + consent → automatic WhatsApp; no consent → call task; running again sends nothing new', async () => {
    await setEndDate('POL-2025-00418', 7);  // Ravi (consent given)
    await setEndDate('POL-2025-01127', 30); // Sneha (no consent)
    const tasksBefore = await Task.countDocuments();

    const first = await runRenewalReminders();
    expect(first).toMatchObject({ messages: 1, tasks: 1 });
    const [msg] = await autoMessages();
    expect(msg).toMatchObject({ customerName: 'Ravi Kumar', channel: 'WhatsApp', status: 'Sent', templateName: 'Renewal reminder', sentBy: null });
    expect(msg!.text).toContain('POL-2025-00418');
    const task = await Task.findOne({ title: /Renewal call: Sneha Rao/ }).lean();
    expect(task).toMatchObject({ type: 'Call', done: false, relatedTo: 'Policy: POL-2025-01127' });

    const again = await runRenewalReminders();
    expect(again).toMatchObject({ messages: 0, tasks: 0 });
    expect(await autoMessages()).toHaveLength(1);
    expect(await Task.countDocuments()).toBe(tasksBefore + 1);
  });

  it('only on the configured days, and never for closed renewals', async () => {
    await setEndDate('POL-2025-00090', 6); // not 30 / 7 / 1
    expect(await runRenewalReminders()).toMatchObject({ policies: 2, messages: 0, tasks: 0 }); // only the two already reminded
    await setEndDate('POL-2025-00090', 1);
    await RenewalState.create({ orgId: await demoOrgId(), policyId: (await Policy.findOne({ policyNumber: 'POL-2025-00090' }).lean())!._id, closedReason: 'Sold the car' });
    expect(await runRenewalReminders()).toMatchObject({ messages: 0, tasks: 0, skipped: 1 });
    await RenewalState.deleteMany({});
  });

  it('Basic plan gets a task instead of WhatsApp; an expired plan gets nothing', async () => {
    await setDemoPlan('basic');
    await Policy.updateOne({ policyNumber: 'POL-2025-00090' }, { $set: { endDate: todayInIndia(1) } });
    const basic = await runRenewalReminders();
    expect(basic).toMatchObject({ messages: 0, tasks: 1 });
    expect(await Task.exists({ title: /Renewal call: Ravi Kumar – POL-2025-00090/ })).toBeTruthy();

    await setDemoPlan('pro', { expired: true });
    await Policy.updateOne({ policyNumber: 'POL-2025-00090' }, { $set: { endDate: todayInIndia(30) } });
    expect(await runRenewalReminders()).toMatchObject({ messages: 0, tasks: 0 });
    await setDemoPlan('pro');
  });
});

describe('Birthday wishes', () => {
  it('wishes customers born today, once per year', async () => {
    await Customer.updateOne({ name: 'Ravi Kumar' }, { $set: { dob: `1986-${todayInIndia().slice(5)}` } });
    expect(await runBirthdayWishes()).toMatchObject({ messages: 1, tasks: 0 });
    expect((await autoMessages()).at(-1)).toMatchObject({ templateName: 'Birthday wishes', text: 'Happy birthday Ravi! Wishing you good health and happiness.' });
    expect(await runBirthdayWishes()).toMatchObject({ messages: 0, tasks: 0 });
  });
});

describe('Payment reminders', () => {
  it('reminds once per link after 24 hours, with the amount and the payment link', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const q = await newQuote(token, { accept: true });
    const link = await api().post(`${V1}/quotations/${q.id}/payment-link`).set(bearer(token)).send({ method: 'Payment link' });
    expect(link.status).toBe(201);
    expect(await runPaymentReminders()).toMatchObject({ messages: 0 }); // too early

    await Payment.updateOne({ _id: link.body.id }, { $set: { 'attempts.0.createdAt': new Date(Date.now() - 25 * 3_600_000) } });
    expect(await runPaymentReminders()).toMatchObject({ messages: 1 });
    const msg = (await autoMessages()).at(-1)!;
    expect(msg.templateName).toBe('Payment reminder');
    expect(msg.text).toContain(q.quoteNumber);
    expect(msg.text).toContain(link.body.link as string);
    expect(msg.text).toMatch(/₹[\d,]+/);
    expect(await runPaymentReminders()).toMatchObject({ messages: 0 });
  });

  it('the payment reminder template is automatic only (not offered in the app)', async () => {
    const t = await api().get(`${V1}/templates`).set(bearer(await tokenOf(DEMO.advisor.email)));
    expect((t.body.items as { name: string }[]).map((i) => i.name)).not.toContain('Payment reminder');
  });
});

describe('Plan renewal reminders', () => {
  it('sends the owner a payment link by SMS before the renewal date; paying extends the plan', async () => {
    const spy = vi.spyOn(sms, 'send');
    const orgId = await demoOrgId();
    const end = new Date(Date.now() + 2 * DAY);
    await Subscription.updateOne({ orgId }, { $set: { planId: 'pro', status: 'ACTIVE', cycle: 'monthly', currentPeriodEnd: end, autoRenew: true } });

    expect(await runPlanReminders()).toMatchObject({ renewalLinks: 1 });
    const c = (await SubscriptionCheckout.findOne({ orgId, automatic: true }).lean())!;
    expect(c).toMatchObject({ planId: 'pro', cycle: 'monthly', total: 1179, status: 'PENDING' });
    expect(c.expiresAt!.getTime()).toBe(end.getTime() + 3 * DAY); // works through the grace days
    expect(spy).toHaveBeenCalledWith(DEMO.advisor.mobile, 'plan_renewal', expect.objectContaining({ plan: 'Pro', link: c.url }));

    expect(await runPlanReminders()).toMatchObject({ renewalLinks: 0 });
    expect(await SubscriptionCheckout.countDocuments({ orgId, automatic: true })).toBe(1);

    expect(await applyCheckoutResult({ providerLinkId: c.providerLinkId, outcome: 'PAID', amountPaise: 117_900 })).toBe('applied');
    const sub = (await Subscription.findOne({ orgId }).lean())!;
    expect(sub.currentPeriodEnd.getTime()).toBe(end.getTime() + 30 * DAY); // continues after the paid period
    spy.mockRestore();
  });

  it('respects "auto-renew off", and reminds trials ending soon', async () => {
    const spy = vi.spyOn(sms, 'send');
    const orgId = await demoOrgId();
    await Subscription.updateOne({ orgId }, { $set: { currentPeriodEnd: new Date(Date.now() + DAY), autoRenew: false } });
    const { input, challenge } = await registerAdvisor({ approve: true });
    const trialOrg = (await User.findById(challenge.userId).lean())!.orgId;
    await Subscription.updateOne({ orgId: trialOrg }, { $set: { currentPeriodEnd: new Date(Date.now() + 2 * DAY) } });

    expect(await runPlanReminders()).toMatchObject({ renewalLinks: 0, trialReminders: 1 });
    expect(spy).toHaveBeenCalledWith(input.mobile, 'trial_ending', expect.objectContaining({ date: expect.any(String) as string }));
    expect(await runPlanReminders()).toMatchObject({ trialReminders: 0 });
    spy.mockRestore();
  });
});

describe('Expiry jobs', () => {
  it('closes unaccepted quotations past validity; accepted ones stay', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const open = await newQuote(token);
    const accepted = await newQuote(token, { accept: true });
    await Quotation.updateMany({ _id: { $in: [open.id, accepted.id] } }, { $set: { validUntil: new Date(Date.now() - 1000) } });

    expect((await runExpireQuotes()).expiredQuotes).toBe(1);
    expect(await Quotation.findById(open.id).lean()).toMatchObject({ status: 'CANCELLED', cancelReason: 'Expired' });
    expect(await Quotation.findById(accepted.id).lean()).toMatchObject({ status: 'ACCEPTED' });
  });

  it('marks expired payment and plan links failed', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const q = await newQuote(token, { accept: true });
    const link = await api().post(`${V1}/quotations/${q.id}/payment-link`).set(bearer(token)).send({ method: 'Payment link' });
    await Payment.updateOne({ _id: link.body.id }, { $set: { linkExpiresAt: new Date(Date.now() - 1000) } });
    await SubscriptionCheckout.updateMany({ status: 'PENDING' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const pendingCheckouts = await SubscriptionCheckout.countDocuments({ status: 'PENDING' });

    expect(await runExpirePaymentLinks()).toMatchObject({ expiredPayments: 1, expiredPlanCheckouts: pendingCheckouts });
    expect(await Payment.findById(link.body.id).lean()).toMatchObject({ status: 'FAILED', failureReason: 'Payment link expired' });
    const retry = await api().post(`${V1}/payments/${link.body.id}/retry`).set(bearer(token));
    expect(retry.body.status).toBe('PENDING'); // the advisor can send a fresh link
  });
});
