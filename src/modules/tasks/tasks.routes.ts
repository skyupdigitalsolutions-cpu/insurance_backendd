import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { idParams, optionalText } from '../../lib/validators.js';
import { TASK_TYPES } from './task.model.js';
import { createTask, listTasks, setTaskDone, updateTask } from './tasks.service.js';

export const taskRoutes = [
  defineRoute({
    method: 'get', path: '/tasks', tag: 'Tasks', summary: 'Tasks and follow-ups (earliest due first)',
    access: 'user', permission: 'task:read', query: z.object({ status: z.enum(['all', 'open', 'done']).default('all') }),
    handler: ({ auth, query }) => listTasks(orgIdOf(auth), query.status),
  }),
  defineRoute({
    method: 'post', path: '/tasks', tag: 'Tasks', summary: 'Create a task',
    access: 'user', permission: 'task:read', status: 201,
    body: z.object({
      title: z.string().trim().min(1, 'Title is required.').max(120),
      type: z.enum(TASK_TYPES, { message: 'Choose a task type' }),
      due: z.iso.datetime({ offset: true, message: 'Choose a valid due date and time' }).transform((v) => new Date(v)),
      relatedTo: optionalText(120),
    }),
    handler: ({ auth, body }) => createTask(auth, orgIdOf(auth), body),
  }),
  defineRoute({
    method: 'patch', path: '/tasks/:id/edit', tag: 'Tasks', summary: 'Edit a task title, type, due date or related-to',
    access: 'user', permission: 'task:read', params: idParams,
    body: z.object({
      title: z.string().trim().min(1).max(120).optional(),
      type: z.enum(TASK_TYPES).optional(),
      due: z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional(),
      relatedTo: z.string().trim().max(120).nullable().optional(),
    }),
    handler: ({ auth, params, body }) => updateTask(orgIdOf(auth), params.id, body),
  }),
  defineRoute({
    method: 'patch', path: '/tasks/:id', tag: 'Tasks', summary: 'Mark a task done / not done',
    access: 'user', permission: 'task:read', params: idParams, body: z.object({ done: z.boolean() }),
    handler: ({ auth, params, body }) => setTaskDone(orgIdOf(auth), params.id, body.done),
  }),
];