import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { hmacSha256, randomDigits, safeEqualHex } from '../../lib/crypto.js';
import { AppError, badRequest, tooManyRequests } from '../../lib/errors.js';
import { OtpChallenge, type OtpChallengeDoc } from './otp.model.js';
import { sms } from './sms.js';

export const OTP_TTL_MS = 5 * 60_000; // code valid for 5 minutes
export const OTP_RESEND_AFTER_SEC = 30;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_PER_HOUR = 5; // codes per user per hour

const EXPIRED_MESSAGE = 'This code has expired. Tap "Resend code".';

const hashCode = (challengeId: Types.ObjectId, code: string) => hmacSha256(env.OTP_SECRET, `${challengeId.toString()}:${code}`);

// Creates a new code, stores only its HMAC, and sends it by SMS
export async function createOtpChallenge(user: { _id: Types.ObjectId; mobile: string }): Promise<OtpChallengeDoc> {
  const since = new Date(Date.now() - 60 * 60_000);
  const recent = await OtpChallenge.countDocuments({ userId: user._id, createdAt: { $gte: since } });
  if (recent >= OTP_MAX_PER_HOUR) {
    throw tooManyRequests('Too many codes requested. Please try again after an hour.', 'OTP_LIMIT_REACHED');
  }

  const _id = new Types.ObjectId();
  const code = env.OTP_FIXED_CODE ?? randomDigits(6);
  const now = Date.now();
  const challenge = await OtpChallenge.create({
    _id,
    userId: user._id,
    purpose: 'REGISTRATION',
    codeHash: hashCode(_id, code),
    expiresAt: new Date(now + OTP_TTL_MS),
    resendAvailableAt: new Date(now + OTP_RESEND_AFTER_SEC * 1000),
  });
  await sms.send(user.mobile, 'otp', { code });
  return challenge.toObject();
}

// Resend: the old code stops working, a new one is sent
export async function resendOtpChallenge(challengeId: string, mobileOf: (userId: Types.ObjectId) => Promise<string>) {
  const old = Types.ObjectId.isValid(challengeId) ? await OtpChallenge.findById(challengeId).lean() : null;
  // A locked or expired code may be replaced; a used or already-replaced one may not
  if (!old || old.consumedReason === 'VERIFIED' || old.consumedReason === 'RESENT') {
    throw badRequest('This code request has expired. Please register again.', 'OTP_CHALLENGE_INVALID');
  }
  const waitSec = Math.ceil((old.resendAvailableAt.getTime() - Date.now()) / 1000);
  if (waitSec > 0) throw tooManyRequests(`Please wait ${waitSec} seconds before requesting a new code.`, 'OTP_RESEND_TOO_SOON');

  const mobile = await mobileOf(old.userId);
  const next = await createOtpChallenge({ _id: old.userId, mobile });
  await OtpChallenge.updateOne({ _id: old._id }, { $set: { consumedAt: new Date(), consumedReason: 'RESENT' } });
  return next;
}

// Checks a code. Each wrong try counts; after 5 the challenge is locked.
// Returns the userId the challenge belongs to.
export async function verifyOtpChallenge(challengeId: string, code: string): Promise<Types.ObjectId> {
  if (!Types.ObjectId.isValid(challengeId)) throw badRequest(EXPIRED_MESSAGE, 'OTP_EXPIRED');

  // Atomic increment: two parallel requests cannot both get "free" attempts
  const c = await OtpChallenge.findOneAndUpdate(
    { _id: challengeId, consumedAt: null },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' },
  ).lean();
  if (!c || c.expiresAt <= new Date()) throw badRequest(EXPIRED_MESSAGE, 'OTP_EXPIRED');

  if (c.attempts > OTP_MAX_ATTEMPTS) {
    await OtpChallenge.updateOne({ _id: c._id }, { $set: { consumedAt: new Date(), consumedReason: 'LOCKED' } });
    throw new AppError(429, 'OTP_TOO_MANY_ATTEMPTS', 'Too many attempts. Tap "Resend code" to get a new one.');
  }
  if (!safeEqualHex(c.codeHash, hashCode(c._id, code))) {
    throw badRequest(`Incorrect code. ${OTP_MAX_ATTEMPTS - c.attempts} attempt(s) left.`, 'OTP_INCORRECT');
  }

  // Mark as used; if another request used it first, treat it as expired
  const used = await OtpChallenge.updateOne(
    { _id: c._id, consumedAt: null },
    { $set: { consumedAt: new Date(), consumedReason: 'VERIFIED' } },
  );
  if (used.modifiedCount !== 1) throw badRequest(EXPIRED_MESSAGE, 'OTP_EXPIRED');
  return c.userId;
}
