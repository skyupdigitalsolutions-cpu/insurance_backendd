import type { Types } from 'mongoose';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { isDuplicateKeyError } from '../../middleware/error.js';
import type { AuthContext } from '../../middleware/auth.js';
import { audit } from '../audit/audit.service.js';
import { ADVISOR_ROLE, STAFF_ROLE, isOrgPermission } from './permissions.js';
import { Role, type RoleDoc } from './role.model.js';

export const toRole = (r: Pick<RoleDoc, '_id' | 'name' | 'permissions' | 'system'>) => ({
  id: r._id.toString(),
  name: r.name,
  permissions: r.permissions,
  system: r.system,
});

const nameKeyOf = (name: string) => name.trim().toLowerCase();

// Called when a new advisor account is created
export async function createDefaultRoles(orgId: Types.ObjectId) {
  const advisor = await Role.create({
    orgId, key: ADVISOR_ROLE.key, name: ADVISOR_ROLE.name, nameKey: nameKeyOf(ADVISOR_ROLE.name),
    permissions: [...ADVISOR_ROLE.permissions], system: true,
  });
  const staff = await Role.create({
    orgId, key: STAFF_ROLE.key, name: STAFF_ROLE.name, nameKey: nameKeyOf(STAFF_ROLE.name),
    permissions: [...STAFF_ROLE.permissions], system: false,
  });
  return { advisor, staff };
}

function checkPermissions(permissions: string[]): string[] {
  const unique = [...new Set(permissions)];
  const unknown = unique.filter((p) => !isOrgPermission(p));
  if (unknown.length) throw badRequest(`Unknown permission: ${unknown.join(', ')}`, 'UNKNOWN_PERMISSION');
  return unique;
}

export async function listRoles(orgId: Types.ObjectId) {
  const roles = await Role.find({ orgId }).sort({ system: -1, name: 1 }).lean();
  return { items: roles.map(toRole) };
}

export async function createRole(auth: AuthContext, orgId: Types.ObjectId, input: { name: string; permissions: string[] }) {
  const permissions = checkPermissions(input.permissions);
  try {
    const role = await Role.create({ orgId, name: input.name, nameKey: nameKeyOf(input.name), permissions, system: false });
    await audit({ orgId, actorUserId: auth.userId, action: 'role.create', entity: 'Role', entityId: role._id, meta: { name: role.name, permissions } });
    return toRole(role);
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('A role with this name already exists.');
    throw err;
  }
}

export async function updateRole(auth: AuthContext, orgId: Types.ObjectId, roleId: string, input: { name: string; permissions: string[] }) {
  const role = await Role.findOne({ _id: roleId, orgId });
  if (!role) throw notFound('Role not found');
  if (role.system) throw forbidden('The Advisor role cannot be changed.', 'SYSTEM_ROLE');
  const permissions = checkPermissions(input.permissions);
  const before = { name: role.name, permissions: role.permissions };
  role.name = input.name;
  role.nameKey = nameKeyOf(input.name);
  role.permissions = permissions;
  try {
    await role.save();
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('A role with this name already exists.');
    throw err;
  }
  await audit({ orgId, actorUserId: auth.userId, action: 'role.update', entity: 'Role', entityId: role._id, meta: { before, after: { name: role.name, permissions } } });
  return toRole(role);
}
