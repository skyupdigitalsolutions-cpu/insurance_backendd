import type { Types } from 'mongoose';
import { temporaryPassword } from '../../lib/crypto.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/auth.js';
import { isDuplicateKeyError } from '../../middleware/error.js';
import { audit } from '../audit/audit.service.js';
import { hashPassword, revokeAllSessions } from '../auth/auth.service.js';
import { sms } from '../auth/sms.js';
import { Role } from '../roles/role.model.js';
import { assertSeatAvailable } from '../subscription/subscription.service.js';
import { User, type UserDoc } from './user.model.js';

type UserLike = Pick<UserDoc, '_id' | 'name' | 'email' | 'mobile' | 'roleId' | 'status'>;

// Shape returned to the app (matches the app's `AppUser` type, plus status)
export const toAppUser = (u: UserLike, roleName: string) => ({
  id: u._id.toString(),
  name: u.name,
  email: u.email,
  mobile: u.mobile,
  roleId: u.roleId.toString(),
  roleName,
  active: u.status === 'ACTIVE',
  status: u.status,
});

export async function listUsers(orgId: Types.ObjectId) {
  const [users, roles] = await Promise.all([
    User.find({ orgId }).sort({ createdAt: 1 }).lean(),
    Role.find({ orgId }).lean(),
  ]);
  const roleName = new Map(roles.map((r) => [r._id.toString(), r.name]));
  return { items: users.map((u) => toAppUser(u, roleName.get(u.roleId.toString()) ?? '—')) };
}

async function staffRoleOrThrow(orgId: Types.ObjectId, roleId: string) {
  const role = await Role.findOne({ _id: roleId, orgId }).lean();
  if (!role) throw badRequest('Choose a valid role.', 'INVALID_ROLE');
  if (role.key === 'advisor') throw badRequest('The Advisor role is reserved for the account owner.', 'INVALID_ROLE');
  return role;
}

// The advisor adds a staff member. A temporary password is created and returned ONCE;
// the staff member must change it at first login.
export async function createUser(auth: AuthContext, orgId: Types.ObjectId, input: { name: string; email: string; mobile: string; roleId: string }) {
  const role = await staffRoleOrThrow(orgId, input.roleId);
  await assertSeatAvailable(orgId); // Basic: 1 user, Pro / Trial: 5
  if (await User.exists({ $or: [{ email: input.email }, { mobile: input.mobile }] })) {
    throw conflict('A user with this email or mobile already exists.');
  }
  const password = temporaryPassword();
  try {
    const user = await User.create({
      orgId, roleId: role._id, name: input.name, email: input.email, mobile: input.mobile,
      passwordHash: await hashPassword(password), status: 'ACTIVE', mustChangePassword: true,
    });
    await sms.send(user.mobile, 'staff_invite', { by: auth.name, email: user.email, password });
    await audit({ orgId, actorUserId: auth.userId, action: 'user.create', entity: 'User', entityId: user._id, meta: { roleId: role._id.toString() } });
    return { ...toAppUser(user, role.name), temporaryPassword: password };
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('A user with this email or mobile already exists.');
    throw err;
  }
}

export async function updateUser(auth: AuthContext, orgId: Types.ObjectId, userId: string, input: { active?: boolean; roleId?: string; name?: string }) {
  const user = await User.findOne({ _id: userId, orgId });
  if (!user) throw notFound('User not found');
  const role = await Role.findById(user.roleId).lean();
  if (role?.key === 'advisor') throw badRequest('The account owner cannot be changed here.', 'OWNER_PROTECTED');

  const changes: Record<string, unknown> = {};
  if (input.active !== undefined) {
    if (user._id.equals(auth.userId)) throw badRequest('You cannot deactivate your own account.', 'SELF_DEACTIVATE');
    if (user.status !== 'ACTIVE' && user.status !== 'INACTIVE') throw badRequest('This account cannot be changed yet.', 'INVALID_STATUS');
    if (input.active && user.status === 'INACTIVE') await assertSeatAvailable(orgId);
    user.status = input.active ? 'ACTIVE' : 'INACTIVE';
    changes.active = input.active;
  }
  let roleName = role?.name ?? '—';
  if (input.roleId !== undefined) {
    const newRole = await staffRoleOrThrow(orgId, input.roleId);
    user.roleId = newRole._id;
    roleName = newRole.name;
    changes.roleId = input.roleId;
  }
  if (input.name !== undefined) {
    user.name = input.name;
    changes.name = input.name;
  }
  await user.save();
  if (input.active === false) await revokeAllSessions(user._id, 'DEACTIVATED'); // logged out everywhere at once
  await audit({ orgId, actorUserId: auth.userId, action: 'user.update', entity: 'User', entityId: user._id, meta: changes });
  return toAppUser(user, roleName);
}
