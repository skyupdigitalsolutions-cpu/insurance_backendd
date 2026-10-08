// Automatic customer reminders (SRS §16 Communication Engine, §21 Scheduler jobs).
// Premium (Pro plan, "whatsapp" feature): the reminder is sent to the customer on WhatsApp automatically,
//   only with an approved template and only if the customer gave consent.
// Standard (Basic plan) or no consent: a task is created for the advisor to follow up by hand.
// Every reminder is handled once (ReminderLog), so re-running a job never messages anyone twice.
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { formatDate, todayInIndia } from '../../lib/dates.js';
import { logger } from '../../lib/logger.js';
import { blockedReason, deliver, templateForEvent, type TemplateVars } from '../communications/communications.service.js';
import { Customer, type CustomerDoc } from '../customers/customer.model.js';
import { Payment, type PaymentDoc } from '../payments/payment.model.js';
import { Policy, type PolicyDoc } from '../policies/policy.model.js';
import { buildRenewals } from '../renewals/renewals.service.js';
import type { FeatureKey } from '../subscription/plans.js';
import { featuresOf } from '../subscription/subscription.service.js';
import { Task } from '../tasks/task.model.js';
import { claimReminder } from './reminderLog.model.js';

type Outcome = 'message' | 'task' | 'skipped';
export type ReminderSummary = { messages: number; tasks: number; skipped: number };

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

// Features of each organization, looked up once per job run
function featureCache() {
  const cache = new Map<string, Promise<FeatureKey[]>>();
  return (orgId: Types.ObjectId) => {
    const key = orgId.toString();
    if (!cache.has(key)) cache.set(key, featuresOf(orgId).then((f) => f.features));
    return cache.get(key)!;
  };
}

// Sends the WhatsApp template when allowed, otherwise creates the advisor's follow-up task
async function remind(input: {
  orgId: Types.ObjectId; customer: CustomerDoc; features: FeatureKey[]; event: string; vars?: TemplateVars;
  task: { title: string; type: 'Call' | 'Payment follow-up' | 'Other'; relatedTo: string };
}): Promise<Outcome> {
  const { orgId, customer, features } = input;
  if (features.includes('whatsapp')) {
    const template = await templateForEvent(orgId, input.event);
    if (template && !blockedReason(template, customer)) {
      const m = await deliver({ orgId, customer, template, vars: input.vars ?? {}, sentBy: null });
      if (m.status === 'Sent') return 'message';
      // Provider failure: fall through so the advisor still gets a task
    }
  }
  if (!features.includes('crm')) return 'skipped';
  await Task.create({ orgId, title: input.task.title.slice(0, 120), type: input.task.type, due: new Date(), relatedTo: input.task.relatedTo, createdBy: null });
  return 'task';
}

const count = (summary: ReminderSummary, o: Outcome) => {
  if (o === 'message') summary.messages += 1;
  else if (o === 'task') summary.tasks += 1;
  else summary.skipped += 1;
};

// Daily: policies whose renewal date is exactly 30 / 7 / 1 days away (RENEWAL_REMINDER_DAYS)
export async function runRenewalReminders(): Promise<ReminderSummary & { policies: number }> {
  const summary = { messages: 0, tasks: 0, skipped: 0, policies: 0 };
  const features = featureCache();
  for (const days of env.RENEWAL_REMINDER_DAYS) {
    const due = todayInIndia(days);
    const policies = await Policy.find({ status: 'ACTIVE', endDate: due }).lean<PolicyDoc[]>();
    for (const pol of policies) {
      summary.policies += 1;
      const f = await features(pol.orgId);
      if (!f.includes('renewals')) { summary.skipped += 1; continue; } // plan expired
      const [renewal] = await buildRenewals(pol.orgId, [pol]);
      if (!renewal || renewal.status === 'Renewed' || renewal.status === 'Closed') { summary.skipped += 1; continue; }
      const customer = await Customer.findById(pol.customerId).lean<CustomerDoc>();
      if (!customer) { summary.skipped += 1; continue; }
      if (!(await claimReminder(`renewal:${pol._id.toString()}:${days}`, pol.orgId, 'renewal', 'sent'))) continue;
      const number = pol.policyNumber ?? pol.productName;
      const outcome = await remind({
        orgId: pol.orgId, customer, features: f, event: 'Renewal',
        vars: { ...(pol.policyNumber ? { policy: pol.policyNumber } : {}), due: formatDate(due) },
        task: { title: `Renewal call: ${customer.name} – ${number} due ${formatDate(due)}`, type: 'Call', relatedTo: `Policy: ${number}` },
      });
      count(summary, outcome);
    }
  }
  logger.info(summary, 'Renewal reminders done');
  return summary;
}

// Daily: customers whose birthday is today (29 Feb birthdays are wished on 28 Feb in other years)
export async function runBirthdayWishes(): Promise<ReminderSummary> {
  const summary = { messages: 0, tasks: 0, skipped: 0 };
  const today = todayInIndia();
  const [year, mmdd] = [today.slice(0, 4), today.slice(5)];
  const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = mmdd === '02-28' && !isLeap(Number(year)) ? ['02-28', '02-29'] : [mmdd];
  const customers = await Customer.find({ dob: { $regex: `-(${days.join('|')})$` } }).lean<CustomerDoc[]>();
  const features = featureCache();
  for (const c of customers) {
    const f = await features(c.orgId);
    if (!f.length) { summary.skipped += 1; continue; }
    if (!(await claimReminder(`birthday:${c._id.toString()}:${year}`, c.orgId, 'birthday', 'sent'))) continue;
    count(summary, await remind({
      orgId: c.orgId, customer: c, features: f, event: 'Birthday',
      task: { title: `Wish ${c.name} a happy birthday`, type: 'Other', relatedTo: `Customer: ${c.name}` },
    }));
  }
  logger.info(summary, 'Birthday wishes done');
  return summary;
}

// Hourly: payment links still unpaid PAYMENT_REMINDER_AFTER_HOURS after they were sent (one reminder per link)
export async function runPaymentReminders(now = new Date()): Promise<ReminderSummary> {
  const summary = { messages: 0, tasks: 0, skipped: 0 };
  const cutoff = new Date(now.getTime() - env.PAYMENT_REMINDER_AFTER_HOURS * 3_600_000);
  const open = await Payment.find({ status: 'PENDING', linkExpiresAt: { $gt: now }, 'attempts.createdAt': { $lte: cutoff } }).limit(500).lean<PaymentDoc[]>();
  const features = featureCache();
  for (const p of open) {
    const current = p.attempts.find((a) => a.providerLinkId === p.providerLinkId);
    if (!current?.createdAt || current.createdAt > cutoff || !p.link) continue; // the current link is still fresh
    const f = await features(p.orgId);
    if (!f.length) { summary.skipped += 1; continue; }
    const customer = await Customer.findById(p.customerId).lean<CustomerDoc>();
    if (!customer) { summary.skipped += 1; continue; }
    if (!(await claimReminder(`payment:${p._id.toString()}:${p.providerLinkId ?? ''}`, p.orgId, 'payment', 'sent'))) continue;
    count(summary, await remind({
      orgId: p.orgId, customer, features: f, event: 'PaymentReminder',
      vars: { amount: rupees(p.amount), quote: p.quoteNumber, link: p.link },
      task: { title: `Remind ${customer.name} to pay ${rupees(p.amount)} (${p.quoteNumber})`, type: 'Payment follow-up', relatedTo: `Customer: ${customer.name}` },
    }));
  }
  logger.info(summary, 'Payment reminders done');
  return summary;
}
