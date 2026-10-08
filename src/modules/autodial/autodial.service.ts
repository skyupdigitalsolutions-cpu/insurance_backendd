import { Types } from 'mongoose';
import { startOfIndianDay, todayInIndia } from '../../lib/dates.js';
import { forbidden } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/auth.js';
import { Lead, type LeadDoc } from '../leads/lead.model.js';
import { addActivity } from '../leads/leads.service.js';
import { listRenewals, logRenewalContact } from '../renewals/renewals.service.js';
import { createTask } from '../tasks/tasks.service.js';
import { CallLog, type CallLogDoc } from './callLog.model.js';

export type AutodialList = 'new_leads' | 'open_leads' | 'renewals';
type Outcome = CallLogDoc['outcome'];

// Who to call next, in a sensible order (oldest leads first, soonest renewals first)
export async function queue(orgId: Types.ObjectId, list: AutodialList) {
  if (list === 'renewals') {
    const { items } = await listRenewals(orgId, '30d', 200);
    return {
      items: items.filter((r) => r.status !== 'Renewed' && r.status !== 'Closed').map((r) => ({
        id: `r-${r.id}`, kind: 'renewal' as const, refId: r.id, name: r.customerName, mobile: r.customerMobile,
        subtitle: `${r.productName} · due in ${r.daysLeft} day${r.daysLeft === 1 ? '' : 's'}`,
      })),
    };
  }
  const statuses = list === 'new_leads' ? ['NEW'] as const : ['CONTACTED', 'QUALIFIED', 'QUOTATION', 'FOLLOW_UP'] as const;
  const leads = await Lead.find({ orgId, status: { $in: [...statuses] } }).sort({ createdAt: 1 }).limit(200).lean<LeadDoc[]>();
  return {
    items: leads.map((l) => ({
      id: `l-${l._id.toString()}`, kind: 'lead' as const, refId: l._id.toString(), name: l.name, mobile: l.mobile,
      subtitle: `${l.status.replace('_', ' ')} · ${l.requirement ?? l.source}`,
    })),
  };
}

const toCallLog = (c: CallLogDoc) => ({
  id: c._id.toString(), name: c.name, mobile: c.mobile, kind: c.kind, outcome: c.outcome, notes: c.notes ?? undefined, durationSec: c.durationSec, at: c.createdAt,
});

// Saves the outcome on the lead or renewal itself, so the history stays in one place.
// "Call back" also creates a task for tomorrow 10:00 (India time).
export async function logCall(
  auth: AuthContext, orgId: Types.ObjectId,
  input: { kind: 'lead' | 'renewal'; refId: string; outcome: Outcome; notes?: string | undefined; durationSec: number },
) {
  let name: string;
  let mobile: string;
  if (input.kind === 'lead') {
    if (!auth.permissions.includes('lead:update')) throw forbidden();
    const lead = await addActivity(auth, orgId, input.refId, { type: 'Call', outcome: input.outcome, notes: input.notes });
    ({ name, mobile } = lead);
  } else {
    if (!auth.permissions.includes('renewal:manage')) throw forbidden();
    const r = await logRenewalContact(auth, orgId, input.refId, input.outcome, input.notes);
    ({ customerName: name, customerMobile: mobile } = r);
  }
  if (input.outcome === 'Call back') {
    const due = new Date(startOfIndianDay(todayInIndia(1)).getTime() + 10 * 3_600_000);
    await createTask(auth, orgId, { title: `Call back ${name}`, type: 'Call', due, relatedTo: `${input.kind === 'lead' ? 'Lead' : 'Renewal'}: ${name}` });
  }
  const log = await CallLog.create({
    orgId, userId: auth.userId, kind: input.kind, refId: new Types.ObjectId(input.refId), name, mobile,
    outcome: input.outcome, notes: input.notes ?? null, durationSec: input.durationSec,
  });
  return toCallLog(log.toObject<CallLogDoc>());
}

export async function listCalls(orgId: Types.ObjectId) {
  const items = await CallLog.find({ orgId }).sort({ createdAt: -1, _id: -1 }).limit(200).lean<CallLogDoc[]>();
  return { items: items.map(toCallLog) };
}
