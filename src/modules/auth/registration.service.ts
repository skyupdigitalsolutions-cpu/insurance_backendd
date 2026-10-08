import { Types } from 'mongoose';
import { conflict, notFound } from '../../lib/errors.js';
import { maskMobile } from '../../lib/validators.js';
import { isDuplicateKeyError } from '../../middleware/error.js';
import { audit } from '../audit/audit.service.js';
import { Organization } from '../orgs/organization.model.js';
import { createDefaultRoles } from '../roles/roles.service.js';
import { Role } from '../roles/role.model.js';
import { createTrial } from '../subscription/subscription.service.js';
import { User } from '../users/user.model.js';
import { hashPassword, type ClientInfo } from './auth.service.js';
import { OtpChallenge } from './otp.model.js';
import { OTP_RESEND_AFTER_SEC, createOtpChallenge, resendOtpChallenge, verifyOtpChallenge } from './otp.service.js';

export type RegistrationInput = { name: string; email: string; mobile: string; password: string; irdaiNumber?: string | undefined };

const challengeResponse = (c: { _id: Types.ObjectId; userId: Types.ObjectId }, mobile: string) => ({
  challengeId: c._id.toString(),
  userId: c.userId.toString(),
  maskedMobile: maskMobile(mobile),
  resendAfterSec: OTP_RESEND_AFTER_SEC,
});

// Removes a registration that never verified its mobile (nobody proved they own it)
async function deleteUnverifiedRegistration(userId: Types.ObjectId, orgId: Types.ObjectId | null): Promise<void> {
  await Promise.all([
    User.deleteOne({ _id: userId, status: 'PENDING_OTP' }),
    OtpChallenge.deleteMany({ userId }),
    ...(orgId ? [Organization.deleteOne({ _id: orgId }), Role.deleteMany({ orgId })] : []),
  ]);
}

// Step 1: create the advisor account (status PENDING_OTP) and send the mobile OTP
export async function register(input: RegistrationInput, client: ClientInfo) {
  const existing = await User.find({ $or: [{ email: input.email }, { mobile: input.mobile }] }).lean();
  for (const u of existing) {
    if (u.status !== 'PENDING_OTP') {
      throw conflict(
        u.email === input.email
          ? 'An account with this email already exists. Try logging in.'
          : 'An account with this mobile number already exists. Try logging in.',
        'ACCOUNT_EXISTS',
      );
    }
  }
  // Earlier attempts that never verified the OTP are replaced by this one
  for (const u of existing) await deleteUnverifiedRegistration(u._id, u.orgId ?? null);

  const org = await Organization.create({ name: input.name, irdaiNumber: input.irdaiNumber ?? null });
  let user;
  try {
    const { advisor } = await createDefaultRoles(org._id);
    user = await User.create({
      orgId: org._id, roleId: advisor._id, name: input.name, email: input.email, mobile: input.mobile,
      passwordHash: await hashPassword(input.password), status: 'PENDING_OTP',
    });
  } catch (err) {
    // Undo the organization and roles if the user could not be created (e.g. two sign-ups at the same moment)
    await Promise.all([Organization.deleteOne({ _id: org._id }), Role.deleteMany({ orgId: org._id })]);
    if (isDuplicateKeyError(err)) throw conflict('An account with this email or mobile already exists. Try logging in.', 'ACCOUNT_EXISTS');
    throw err;
  }
  await Organization.updateOne({ _id: org._id }, { $set: { ownerUserId: user._id } });
  await audit({ orgId: org._id, actorUserId: user._id, action: 'registration.create', entity: 'User', entityId: user._id, ip: client.ip, requestId: client.requestId });

  const challenge = await createOtpChallenge(user);
  return challengeResponse(challenge, user.mobile);
}

export async function resendOtp(challengeId: string) {
  let mobile = '';
  const challenge = await resendOtpChallenge(challengeId, async (userId) => {
    const user = await User.findOne({ _id: userId, status: 'PENDING_OTP' }).lean();
    if (!user) throw conflict('This mobile number is already verified.', 'ALREADY_VERIFIED');
    mobile = user.mobile;
    return mobile;
  });
  return challengeResponse(challenge, mobile);
}

// Step 2: correct OTP → mobile verified, free trial starts, account waits for admin approval
export async function verifyOtp(challengeId: string, code: string, client: ClientInfo) {
  const userId = await verifyOtpChallenge(challengeId, code);
  const now = new Date();
  const user = await User.findOneAndUpdate(
    { _id: userId, status: 'PENDING_OTP' },
    { $set: { status: 'PENDING_VERIFICATION', mobileVerifiedAt: now } },
    { returnDocument: 'after' },
  ).lean();
  if (!user) throw conflict('This mobile number is already verified.', 'ALREADY_VERIFIED');
  await Organization.updateOne({ _id: user.orgId, trialStartedAt: null }, { $set: { trialStartedAt: now } });
  if (user.orgId) await createTrial(user.orgId, now); // 14-day free trial with every feature
  await audit({ orgId: user.orgId, actorUserId: user._id, action: 'registration.mobile_verified', entity: 'User', entityId: user._id, ip: client.ip, requestId: client.requestId });
  return { userId: user._id.toString() };
}

// Polled by the app's "Pending approval" screen
export async function registrationStatus(userId: string) {
  const user = Types.ObjectId.isValid(userId) ? await User.findById(userId).lean() : null;
  if (!user) throw notFound('Registration not found');
  const org = user.orgId ? await Organization.findById(user.orgId).lean() : null;
  if (!org?.ownerUserId?.equals(user._id)) throw notFound('Registration not found'); // staff accounts are not registrations
  const status = user.status === 'PENDING_OTP' ? 'PENDING_VERIFICATION' : user.status;
  return { status };
}
