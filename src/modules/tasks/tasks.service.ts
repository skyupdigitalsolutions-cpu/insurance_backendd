import type { Types } from 'mongoose';
import { badRequest, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/auth.js';
import { Task, type TaskDoc } from './task.model.js';

const CLOCK_SKEW_MS = 60_000; // allow a phone clock that is up to a minute behind

export const toTask = (t: TaskDoc) => ({
  id: t._id.toString(),
  title: t.title,
  type: t.type,
  due: t.due,
  relatedTo: t.relatedTo ?? undefined,
  done: t.done,
  createdAt: t.createdAt,
});

export async function listTasks(orgId: Types.ObjectId, status: 'all' | 'open' | 'done') {
  const filter = { orgId, ...(status === 'all' ? {} : { done: status === 'done' }) };
  const items = await Task.find(filter).sort({ due: 1, _id: 1 }).limit(500).lean<TaskDoc[]>();
  return { items: items.map(toTask) };
}

export async function createTask(
  auth: AuthContext, orgId: Types.ObjectId,
  input: { title: string; type: TaskDoc['type']; due: Date; relatedTo?: string | undefined },
) {
  if (input.due.getTime() < Date.now() - CLOCK_SKEW_MS) throw badRequest('Due date and time must be in the future.', 'DUE_IN_PAST');
  const t = await Task.create({ orgId, title: input.title, type: input.type, due: input.due, relatedTo: input.relatedTo ?? null, createdBy: auth.userId });
  return toTask(t.toObject<TaskDoc>());
}

export async function setTaskDone(orgId: Types.ObjectId, taskId: string, done: boolean) {
  const t = await Task.findOneAndUpdate(
    { _id: taskId, orgId },
    { $set: { done, doneAt: done ? new Date() : null } },
    { returnDocument: 'after' },
  ).lean<TaskDoc>();
  if (!t) throw notFound('Task not found');
  return toTask(t);
}

export async function updateTask(
  orgId: Types.ObjectId, taskId: string,
  input: { title?: string; type?: TaskDoc['type']; due?: Date; relatedTo?: string | null },
) {
  const t = await Task.findOneAndUpdate(
    { _id: taskId, orgId },
    { $set: input },
    { returnDocument: 'after' },
  ).lean<TaskDoc>();
  if (!t) throw notFound('Task not found');
  return toTask(t);
}