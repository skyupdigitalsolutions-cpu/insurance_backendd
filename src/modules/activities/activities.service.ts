import type { Types } from 'mongoose';
import { Activity, type ActivityDoc } from './activity.model.js';

type Base = { orgId: Types.ObjectId; entityType: 'Lead' | 'Customer' | 'Task' | 'Policy'; entityId: Types.ObjectId; actorUserId?: Types.ObjectId | null };

export const logEvent = (e: Base & { text: string }) => Activity.create({ ...e, kind: 'EVENT' });

export const logContact = (e: Base & { type: 'Call' | 'WhatsApp' | 'Email' | 'Meeting'; outcome: string; notes?: string | undefined; text: string }) =>
  Activity.create({ ...e, kind: 'CONTACT', notes: e.notes ?? null });

// Shape of a lead's contact history in the app (LeadActivity)
export const toLeadActivity = (a: Pick<ActivityDoc, '_id' | 'type' | 'outcome' | 'notes' | 'at'>) => ({
  id: a._id.toString(),
  type: a.type ?? 'Call',
  outcome: a.outcome ?? '',
  notes: a.notes ?? undefined,
  at: a.at,
});

export async function recentActivity(orgId: Types.ObjectId, limit: number) {
  const items = await Activity.find({ orgId }).sort({ at: -1, _id: -1 }).limit(limit).lean();
  return { items: items.map((a) => ({ id: a._id.toString(), text: a.text, time: a.at })) };
}
