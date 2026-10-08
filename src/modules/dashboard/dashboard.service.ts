import type { Types } from 'mongoose';
import { startOfIndianDay, todayInIndia } from '../../lib/dates.js';
import { Customer } from '../customers/customer.model.js';
import { CustomerDocument } from '../documents/document.model.js';
import { Lead } from '../leads/lead.model.js';
import { Payment } from '../payments/payment.model.js';
import { Policy } from '../policies/policy.model.js';
import { Quotation } from '../quotations/quotation.model.js';
import { listRenewals } from '../renewals/renewals.service.js';
import { Task } from '../tasks/task.model.js';

export type DateRange = 'today' | '7d' | '30d' | 'month';

const QUALIFIED = ['QUALIFIED', 'QUOTATION', 'FOLLOW_UP', 'CONVERTED'] as const;
const ACCEPTED = ['ACCEPTED', 'PAYMENT_PENDING', 'PAID'] as const;

function rangeStart(range: DateRange): Date {
  const today = todayInIndia();
  if (range === '7d') return startOfIndianDay(todayInIndia(-6));
  if (range === '30d') return startOfIndianDay(todayInIndia(-29));
  if (range === 'month') return startOfIndianDay(`${today.slice(0, 8)}01`);
  return startOfIndianDay(today);
}

// The same counting rules feed the dashboard (for a period) and the KPI report (all time)
async function funnel(orgId: Types.ObjectId, from?: Date) {
  const since = (field: string) => (from ? { [field]: { $gte: from } } : {});
  const leadFilter = { orgId, ...since('createdAt') };
  const [totalLeads, newLeads, contacted, qualified, quotes, accepted, paid, issued, comparisonQuotes] = await Promise.all([
    Lead.countDocuments(leadFilter),
    Lead.countDocuments({ ...leadFilter, status: 'NEW' }),
    Lead.countDocuments({ ...leadFilter, status: { $ne: 'NEW' } }),
    Lead.countDocuments({ ...leadFilter, $or: [{ status: { $in: [...QUALIFIED] } }, { customerId: { $ne: null } }] }),
    Quotation.countDocuments({ orgId, ...since('createdAt') }),
    Quotation.countDocuments({ orgId, status: { $in: [...ACCEPTED] }, ...since('createdAt') }),
    Payment.countDocuments({ orgId, status: 'SUCCESS', ...since('paidAt') }),
    Policy.countDocuments({ orgId, status: 'ACTIVE', source: { $ne: 'IMPORTED' }, ...since('issuedAt') }),
    Quotation.find({ orgId, 'comparedProductIds.1': { $exists: true }, ...since('createdAt') }).select('comparedProductIds').lean(),
  ]);
  // "Quoted leads": leads whose customer received at least one quotation
  const leadCustomers = await Lead.distinct('customerId', { ...leadFilter, customerId: { $ne: null } });
  const quotedLeads = leadCustomers.length ? (await Quotation.distinct('customerId', { orgId, customerId: { $in: leadCustomers } })).length : 0;
  return { totalLeads, newLeads, contacted, qualified, quotedLeads, quotes, accepted, paid, issued, comparisonQuotes };
}

export async function dashboardSummary(orgId: Types.ObjectId, range: DateRange) {
  const [f, due7, overdue, activeCustomers] = await Promise.all([
    funnel(orgId, rangeStart(range)),
    listRenewals(orgId, '7d', 500),
    listRenewals(orgId, 'overdue', 500),
    Customer.countDocuments({ orgId }),
  ]);
  const open = (s: string) => s !== 'Renewed' && s !== 'Closed';
  return {
    totalLeads: f.totalLeads, newLeads: f.newLeads, contacted: f.contacted, qualified: f.qualified,
    quotes: f.quotes, accepted: f.accepted, paid: f.paid,
    policies: f.issued, // policies issued in the period
    renewalsDue: due7.items.filter((r) => open(r.status)).length + overdue.items.length,
    activeCustomers,
  };
}

type Pending = {
  id: string; type: 'quote' | 'payment' | 'document' | 'approval' | 'followup' | 'renewal' | 'issuance';
  title: string; customerName: string; dueLabel: string; isOverdue: boolean;
  target: 'quote' | 'payment' | 'policy' | 'customer' | 'task'; targetId: string;
};

// What needs attention now, most urgent first
export async function pendingActions(orgId: Types.ObjectId, limit: number) {
  const endOfToday = startOfIndianDay(todayInIndia(1));
  const startOfToday = startOfIndianDay(todayInIndia());
  const [failed, toIssue, docs, quotes, tasks] = await Promise.all([
    Payment.find({ orgId, status: 'FAILED' }).sort({ updatedAt: -1 }).limit(10).lean(),
    Policy.find({ orgId, status: 'PENDING_ISSUANCE' }).sort({ createdAt: 1 }).limit(10).lean(),
    CustomerDocument.find({ orgId, status: 'Review Required' }).sort({ createdAt: 1 }).limit(10).lean(),
    Quotation.find({ orgId, status: { $in: ['DRAFT', 'GENERATED', 'SENT'] }, validUntil: { $gte: new Date() } }).sort({ createdAt: 1 }).limit(20).lean(),
    Task.find({ orgId, done: false, due: { $lt: endOfToday } }).sort({ due: 1 }).limit(10).lean(),
  ]);
  const docCustomers = new Map(
    (await Customer.find({ _id: { $in: docs.map((d) => d.customerId) } }).select('name').lean()).map((c) => [c._id.toString(), c.name]),
  );

  const items: Pending[] = [
    ...failed.map((p): Pending => ({ id: p._id.toString(), type: 'payment', title: 'Payment failed – retry', customerName: p.customerName, dueLabel: p.quoteNumber, isOverdue: true, target: 'payment', targetId: p._id.toString() })),
    ...tasks.filter((t) => t.due < startOfToday).map((t): Pending => ({ id: t._id.toString(), type: 'followup', title: t.title, customerName: t.relatedTo ?? '', dueLabel: 'Overdue', isOverdue: true, target: 'task', targetId: t._id.toString() })),
    ...toIssue.map((p): Pending => ({ id: p._id.toString(), type: 'issuance', title: 'Policy ready to issue', customerName: p.customerName, dueLabel: 'Payment verified', isOverdue: false, target: 'policy', targetId: p._id.toString() })),
    ...quotes.filter((q) => q.status === 'DRAFT').map((q): Pending => ({ id: q._id.toString(), type: 'approval', title: `Approve ${q.discountPercent}% discount on ${q.quoteNumber}`, customerName: q.customerName, dueLabel: 'Approval', isOverdue: false, target: 'quote', targetId: q._id.toString() })),
    ...docs.map((d): Pending => ({ id: d._id.toString(), type: 'document', title: `${d.type} review required`, customerName: docCustomers.get(d.customerId.toString()) ?? '', dueLabel: 'Review', isOverdue: false, target: 'customer', targetId: d.customerId.toString() })),
    ...tasks.filter((t) => t.due >= startOfToday).map((t): Pending => ({ id: t._id.toString(), type: 'followup', title: t.title, customerName: t.relatedTo ?? '', dueLabel: 'Today', isOverdue: false, target: 'task', targetId: t._id.toString() })),
    ...quotes.filter((q) => q.status === 'GENERATED').map((q): Pending => ({ id: q._id.toString(), type: 'quote', title: `${q.quoteNumber} not sent yet`, customerName: q.customerName, dueLabel: 'Send', isOverdue: false, target: 'quote', targetId: q._id.toString() })),
    ...quotes.filter((q) => q.status === 'SENT').map((q): Pending => ({ id: q._id.toString(), type: 'followup', title: `Awaiting acceptance of ${q.quoteNumber}`, customerName: q.customerName, dueLabel: 'Follow up', isOverdue: false, target: 'quote', targetId: q._id.toString() })),
  ];
  return { items: items.slice(0, limit) };
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—'); // never divide by zero

// KPI report with the formulas of the Advisor-Only specification §15
export async function kpiReport(orgId: Types.ObjectId) {
  const f = await funnel(orgId);
  const cmp = f.comparisonQuotes;
  const compared = cmp.reduce((s, q) => s + q.comparedProductIds.length, 0);
  return {
    funnel: [
      { label: 'Leads', value: f.totalLeads }, { label: 'Contacted', value: f.contacted }, { label: 'Qualified', value: f.qualified },
      { label: 'Quoted', value: f.quotedLeads }, { label: 'Accepted', value: f.accepted }, { label: 'Paid', value: f.paid }, { label: 'Policies', value: f.issued },
    ],
    rates: [
      { label: 'Contact rate', value: pct(f.contacted, f.totalLeads), formula: 'Contacted ÷ Total leads' },
      { label: 'Qualification rate', value: pct(f.qualified, f.contacted), formula: 'Qualified ÷ Contacted' },
      { label: 'Quote rate', value: pct(f.quotedLeads, f.qualified), formula: 'Quoted leads ÷ Qualified' },
      { label: 'Acceptance rate', value: pct(f.accepted, f.quotes), formula: 'Accepted quotes ÷ Generated quotes' },
      { label: 'Payment conversion', value: pct(f.paid, f.accepted), formula: 'Paid ÷ Accepted quotes' },
      { label: 'Policy conversion', value: pct(f.issued, f.paid), formula: 'Issued policies ÷ Paid' },
      { label: 'Overall lead-to-policy', value: pct(f.issued, f.totalLeads), formula: 'Issued policies ÷ Total leads' },
    ],
    comparison: [
      { label: 'Comparison usage', value: pct(cmp.length, f.quotes), formula: 'Quotations made after a comparison ÷ Quotations' },
      { label: 'Average products compared', value: cmp.length ? (compared / cmp.length).toFixed(1) : '—', formula: 'Products compared ÷ Comparisons' },
      { label: 'Comparison completion', value: pct(cmp.length, cmp.length), formula: 'Finalised quotes after comparison ÷ Comparisons' },
    ],
  };
}
