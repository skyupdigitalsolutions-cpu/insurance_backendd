import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { email, idParams, indianMobile, objectId, personName } from '../../lib/validators.js';
import { createUser, listUsers, updateUser } from './users.service.js';

const createUserInput = z.object({ name: personName, email, mobile: indianMobile, roleId: objectId });
const updateUserInput = z
  .object({ active: z.boolean().optional(), roleId: objectId.optional(), name: personName.optional() })
  .refine((v) => v.active !== undefined || v.roleId !== undefined || v.name !== undefined, 'Nothing to update');

export const userRoutes = [
  defineRoute({
    method: 'get', path: '/users', tag: 'Users', summary: 'List users in my organization',
    access: 'user', permission: 'user:manage',
    handler: ({ auth }) => listUsers(orgIdOf(auth)),
  }),
  defineRoute({
    method: 'post', path: '/users', tag: 'Users', summary: 'Add a staff user (returns a one-time temporary password)',
    access: 'user', permission: 'user:manage', body: createUserInput, status: 201,
    handler: ({ auth, body }) => createUser(auth, orgIdOf(auth), body),
  }),
  defineRoute({
    method: 'patch', path: '/users/:id', tag: 'Users', summary: 'Activate/deactivate a user, change role or name',
    access: 'user', permission: 'user:manage', params: idParams, body: updateUserInput,
    handler: ({ auth, params, body }) => updateUser(auth, orgIdOf(auth), params.id, body),
  }),
];
