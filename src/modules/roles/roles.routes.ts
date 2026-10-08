import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { idParams } from '../../lib/validators.js';
import { createRole, listRoles, updateRole } from './roles.service.js';

const roleInput = z.object({
  name: z.string().trim().min(1, 'Role name is required.').max(50, 'Role name must be at most 50 characters.'),
  permissions: z.array(z.string()).min(1, 'Choose at least one permission.').max(100),
});

export const roleRoutes = [
  defineRoute({
    method: 'get', path: '/roles', tag: 'Roles', summary: 'List roles in my organization',
    access: 'user', permission: 'user:manage',
    handler: ({ auth }) => listRoles(orgIdOf(auth)),
  }),
  defineRoute({
    method: 'post', path: '/roles', tag: 'Roles', summary: 'Create a role',
    access: 'user', permission: 'user:manage', body: roleInput, status: 201,
    handler: ({ auth, body }) => createRole(auth, orgIdOf(auth), body),
  }),
  defineRoute({
    method: 'patch', path: '/roles/:id', tag: 'Roles', summary: 'Rename a role or change its permissions',
    access: 'user', permission: 'user:manage', params: idParams, body: roleInput,
    handler: ({ auth, params, body }) => updateRole(auth, orgIdOf(auth), params.id, body),
  }),
];
