// Demo business data for the demo advisor (same people as the app's mock mode),
// so every screen has something to show right after "npm run seed". Never used in production.
import { Types } from 'mongoose';
import { Activity } from '../modules/activities/activity.model.js';
import { Template } from '../modules/communications/communication.models.js';
import { nextNumber } from '../modules/counters/counter.model.js';
import { Policy } from '../modules/policies/policy.model.js';
import { Invoice, Subscription } from '../modules/subscription/subscription.model.js';
import { Customer } from '../modules/customers/customer.model.js';
import { FamilyMember, Nominee } from '../modules/customers/related.models.js';
import { Lead } from '../modules/leads/lead.model.js';
import { Product } from '../modules/products/product.model.js';
import { ReferralCode } from '../modules/referrals/referralCode.model.js';
import { Task } from '../modules/tasks/task.model.js';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const hoursFromNow = (n: number) => new Date(Date.now() + n * 3_600_000);

export async function seedDemoBusinessData(orgId: Types.ObjectId, ownerId: Types.ObjectId): Promise<void> {
  await ReferralCode.create([{ orgId, code: 'REF100' }, { orgId, code: 'REF200' }]);

  const [pooja, rahul, divya] = await Lead.create([
    { orgId, name: 'Pooja Hegde', mobile: '+919845012345', source: 'Referral', referralCode: 'REF100', requirement: 'Health cover for family of 4', status: 'NEW', createdBy: ownerId, createdAt: daysAgo(0) },
    { orgId, name: 'Rahul Menon', mobile: '+919900112233', email: 'rahul@example.com', source: 'Paid Ads', requirement: 'Term life ₹1 crore', status: 'CONTACTED', createdBy: ownerId, createdAt: daysAgo(2) },
    { orgId, name: 'Divya Kulkarni', mobile: '+918123456789', source: 'Campaign', campaign: 'Diwali 2026', requirement: 'Car insurance renewal', status: 'QUALIFIED', createdBy: ownerId, createdAt: daysAgo(5) },
  ]);
  if (!pooja || !rahul || !divya) throw new Error('Demo leads were not created');

  const [ravi, sneha] = await Customer.create([
    { orgId, name: 'Ravi Kumar', mobile: '+919876543210', email: 'ravi@example.com', dob: '1986-04-12', city: 'Bengaluru', pin: '560054', source: 'Referral', consentGiven: true, consentAt: daysAgo(10), nomineePercentTotal: 100, createdBy: ownerId, createdAt: daysAgo(12) },
    { orgId, name: 'Sneha Rao', mobile: '+919812345678', dob: '1992-09-30', city: 'Mysuru', pin: '570001', source: 'Paid Ads', createdBy: ownerId, createdAt: daysAgo(4) },
  ]);
  if (!ravi || !sneha) throw new Error('Demo customers were not created');

  await FamilyMember.create([
    { orgId, customerId: ravi._id, name: 'Lakshmi Kumar', relationship: 'Spouse', dob: '1988-01-20' },
    { orgId, customerId: ravi._id, name: 'Aarav Kumar', relationship: 'Son', dob: '2015-06-02' },
  ]);
  await Nominee.create({ orgId, customerId: ravi._id, name: 'Lakshmi Kumar', relationship: 'Spouse', percent: 100 });

  await Task.create([
    { orgId, title: 'Call Rahul about term plan options', type: 'Call', due: hoursFromNow(3), relatedTo: 'Lead: Rahul Menon', createdBy: ownerId },
    { orgId, title: 'Collect PAN copy', type: 'Documents', due: daysAgo(1), relatedTo: 'Customer: Sneha Rao', createdBy: ownerId },
    { orgId, title: 'Visit for renewal discussion', type: 'Visit', due: hoursFromNow(48), relatedTo: 'Customer: Ravi Kumar', createdBy: ownerId },
  ]);

  await Activity.create([
    { orgId, entityType: 'Lead', entityId: divya._id, kind: 'EVENT', text: 'New lead: Divya Kulkarni (Campaign)', actorUserId: ownerId, at: daysAgo(5) },
    { orgId, entityType: 'Lead', entityId: rahul._id, kind: 'EVENT', text: 'New lead: Rahul Menon (Paid Ads)', actorUserId: ownerId, at: daysAgo(2) },
    { orgId, entityType: 'Lead', entityId: rahul._id, kind: 'CONTACT', type: 'Call', outcome: 'Connected', notes: 'Asked for options by Friday', text: 'Call with Rahul Menon: Connected', actorUserId: ownerId, at: daysAgo(1) },
    { orgId, entityType: 'Lead', entityId: pooja._id, kind: 'EVENT', text: 'New lead: Pooja Hegde (Referral)', actorUserId: ownerId, at: daysAgo(0) },
  ]);
}

// Demo product catalogue (same as the app's mock mode). In production, platform admins maintain products.
export async function seedDemoProducts(): Promise<void> {
  await Product.create([
    {
      name: 'Family Health Optima', companyName: 'Star Health', type: 'Health', basePremium: 18450,
      coverage: '₹10 lakh sum insured, family floater', features: ['Cashless at 14,000+ hospitals', 'No room-rent limit', 'Free annual health check-up'],
      addOns: [{ name: 'Critical illness cover', premium: 3200 }, { name: 'Maternity cover', premium: 4100 }],
      exclusions: 'Pre-existing diseases covered after 3 years', eligibility: 'Age 18–65', minAge: 18, maxAge: 65, source: 'Product brochure v2025.1, page 3',
    },
    {
      name: 'Health Guard Gold', companyName: 'ICICI Lombard', type: 'Health', basePremium: 16900,
      coverage: '₹10 lakh sum insured', features: ['Cashless at 10,000+ hospitals', 'Restore benefit'],
      addOns: [{ name: 'Personal accident cover', premium: 1500 }],
      exclusions: null, eligibility: 'Age 18–60', minAge: 18, maxAge: 60, source: 'Product brochure v2025.3',
    },
    {
      name: 'Care Supreme', companyName: 'Care Health', type: 'Health', basePremium: null,
      coverage: '₹15 lakh sum insured', features: ['Unlimited recharge of sum insured'],
      addOns: [], exclusions: '30-day initial waiting period', eligibility: null, source: null,
    },
    {
      name: 'Click 2 Protect Life', companyName: 'HDFC Life', type: 'Life', basePremium: 12000,
      coverage: '₹1 crore term cover till age 70', features: ['Tax benefit under Sec 80C', 'Terminal illness benefit'],
      addOns: [{ name: 'Accidental death benefit', premium: 1800 }, { name: 'Waiver of premium', premium: 900 }],
      exclusions: 'Suicide within 12 months', eligibility: 'Age 18–60', minAge: 18, maxAge: 60, source: 'Product brochure 2025',
    },
    {
      name: 'iProtect Smart', companyName: 'ICICI Prudential', type: 'Life', basePremium: 11200,
      coverage: '₹1 crore term cover', features: ['Critical illness option'],
      addOns: [{ name: 'Critical illness rider', premium: 2500 }],
      exclusions: null, eligibility: 'Age 18–65', minAge: 18, maxAge: 65, source: 'Product brochure 2025',
    },
    {
      name: 'Car Secure Comprehensive', companyName: 'Bajaj Allianz', type: 'Motor', basePremium: 9320,
      coverage: 'Own damage + third party', features: ['24x7 roadside assistance'],
      addOns: [{ name: 'Zero depreciation', premium: 2100 }, { name: 'Engine protect', premium: 900 }],
      exclusions: 'Driving without valid licence', eligibility: 'Private cars up to 10 years old', source: 'Policy wordings 2025',
    },
  ]);
}

// Message templates every advisor can use (company-approved). Needed in production too.
// waTemplateName = the same template submitted for approval in Meta WhatsApp Manager
// (its body uses {{1}}, {{2}} … in place of our placeholders, in the same order).
export const DEFAULT_TEMPLATES = [
  { name: 'Renewal reminder', event: 'Renewal', channel: 'WhatsApp', waTemplateName: 'renewal_reminder', body: 'Dear {{name}}, your policy {{policy}} is due for renewal on {{due}}. Reply YES and I will share the renewal quote.' },
  { name: 'Birthday wishes', event: 'Birthday', channel: 'WhatsApp', waTemplateName: 'birthday_wishes', body: 'Happy birthday {{name}}! Wishing you good health and happiness.' },
  { name: 'Quotation follow-up', event: 'Quotation', channel: 'Email', body: 'Dear {{name}}, following up on the quotation I shared. Happy to answer any questions.' },
  { name: 'Payment received', event: 'Payment', channel: 'Email', body: 'Dear {{name}}, we have received your payment. Your policy documents will follow shortly.' },
  // Part 5: used only by the automatic payment reminder job (not listed in the app)
  { name: 'Payment reminder', event: 'PaymentReminder', channel: 'WhatsApp', waTemplateName: 'payment_reminder', manual: false, body: 'Dear {{name}}, a gentle reminder to complete the payment of {{amount}} for quotation {{quote}}. Pay securely here: {{link}} (the link is valid for a limited time).' },
] as const;

// Adds missing company templates and fills new fields on older ones (safe to run many times)
export async function seedTemplates(): Promise<number> {
  let added = 0;
  for (const t of DEFAULT_TEMPLATES) {
    const r = await Template.updateOne(
      { orgId: null, name: t.name },
      { $setOnInsert: { ...t, orgId: null, approved: true } },
      { upsert: true },
    );
    added += r.upsertedCount;
    if ('waTemplateName' in t) await Template.updateOne({ orgId: null, name: t.name, waTemplateName: null }, { $set: { waTemplateName: t.waTemplateName } });
  }
  return added;
}

const istDate = (offsetDays: number) => new Date(Date.now() + 5.5 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

// Part 4 demo data: Pro subscription with invoices, and three older policies close to renewal
export async function seedDemoPart4(orgId: Types.ObjectId): Promise<void> {
  if (!(await Subscription.exists({ orgId }))) {
    await Subscription.create({ orgId, planId: 'pro', cycle: 'monthly', status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000), autoRenew: true });
    for (const daysBack of [40, 10]) {
      await Invoice.create({
        orgId, number: await nextNumber('INV', 'platform'), planName: 'Pro', cycle: 'monthly', amount: 999, gst: 180, total: 1179,
        paidAt: new Date(Date.now() - daysBack * 86_400_000),
      });
    }
  }
  if (await Policy.exists({ orgId, source: 'IMPORTED' })) return;
  const ravi = await Customer.findOne({ orgId, name: 'Ravi Kumar' }).lean();
  const sneha = await Customer.findOne({ orgId, name: 'Sneha Rao' }).lean();
  const product = async (name: string) => (await Product.findOne({ name }).lean())!;
  if (!ravi || !sneha) return;
  const imported = async (c: typeof ravi, productName: string, policyNumber: string, premium: number, endInDays: number) => {
    const p = await product(productName);
    await Policy.create({
      orgId, source: 'IMPORTED', policyNumber, quotationId: new Types.ObjectId(), paymentId: null, customerId: c._id, customerName: c.name,
      productId: p._id, productName: p.name, companyName: p.companyName, type: p.type, premium, frequency: 'Yearly', status: 'ACTIVE',
      startDate: istDate(endInDays - 364), endDate: istDate(endInDays), issuedAt: new Date(Date.now() - (365 - endInDays) * 86_400_000),
      createdAt: new Date(Date.now() - (365 - endInDays) * 86_400_000),
    });
  };
  await imported(ravi, 'Family Health Optima', 'POL-2025-00418', 21650, 5);
  await imported(sneha, 'Health Guard Gold', 'POL-2025-01127', 16900, 20);
  await imported(ravi, 'Car Secure Comprehensive', 'POL-2025-00090', 10998, -2);
}
