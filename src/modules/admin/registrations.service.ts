import { Types } from 'mongoose';
import { conflict, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/auth.js';
import { audit } from '../audit/audit.service.js';
import { revokeAllSessions } from '../auth/auth.service.js';
import { sms } from '../auth/sms.js';
import { Organization } from '../orgs/organization.model.js';
import { User, type UserStatus } from '../users/user.model.js';

export async function listRegistrations(query: { status: UserStatus; page: number; limit: number }) {
  // Registrations = organization owners (advisors), not staff
  const ownerIds = await Organization.distinct('ownerUserId', { ownerUserId: { $ne: null } });
  const filter = { _id: { $in: ownerIds }, status: query.status };
  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    User.countDocuments(filter),
  ]);
  const orgs = await Organization.find({ _id: { $in: users.map((u) => u.orgId) } }).lean();
  const irdaiOf = new Map(orgs.map((o) => [o._id.toString(), o.irdaiNumber]));
  return {
    items: users.map((u) => ({
      userId: u._id.toString(),
      name: u.name,
      email: u.email,
      mobile: u.mobile,
      irdaiNumber: irdaiOf.get(u.orgId?.toString() ?? '') ?? null,
      status: u.status,
      registeredAt: u.createdAt,
      mobileVerifiedAt: u.mobileVerifiedAt,
    })),
    page: query.page,
    limit: query.limit,
    total,
  };
}

async function findRegistration(userId: string) {
  const user = Types.ObjectId.isValid(userId) ? await User.findById(userId) : null;
  const org = user?.orgId ? await Organization.findById(user.orgId).lean() : null;
  if (!user || !org?.ownerUserId?.equals(user._id)) throw notFound('Registration not found');
  return user;
}

export async function approveRegistration(admin: AuthContext, userId: string) {
  const user = await findRegistration(userId);
  if (user.status === 'PENDING_OTP') throw conflict('Mobile number is not verified yet.', 'MOBILE_NOT_VERIFIED');
  if (user.status !== 'PENDING_VERIFICATION') throw conflict(`This registration is already ${user.status.toLowerCase()}.`, 'INVALID_STATUS');
  user.status = 'ACTIVE';
  user.approvedAt = new Date();
  user.approvedBy = admin.userId;
  await user.save();
  await sms.send(user.mobile, 'account_approved', {});
  await audit({ orgId: user.orgId, actorUserId: admin.userId, action: 'registration.approve', entity: 'User', entityId: user._id });
  return { userId: user._id.toString(), status: user.status };
}

export async function rejectRegistration(admin: AuthContext, userId: string, reason: string) {
  const user = await findRegistration(userId);
  if (user.status !== 'PENDING_VERIFICATION' && user.status !== 'PENDING_OTP') {
    throw conflict(`This registration is already ${user.status.toLowerCase()}.`, 'INVALID_STATUS');
  }
  user.status = 'REJECTED';
  user.rejectedReason = reason;
  await user.save();
  await revokeAllSessions(user._id, 'REJECTED');
  await audit({ orgId: user.orgId, actorUserId: admin.userId, action: 'registration.reject', entity: 'User', entityId: user._id, meta: { reason } });
  return { userId: user._id.toString(), status: user.status };
}
