import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLog } from '../src/modules/audit/audit.model.js';
import { OtpChallenge } from '../src/modules/auth/otp.model.js';
import { Organization } from '../src/modules/orgs/organization.model.js';
import { ORG_PERMISSIONS } from '../src/modules/roles/permissions.js';
import { Role } from '../src/modules/roles/role.model.js';
import { User } from '../src/modules/users/user.model.js';
import {
  DEMO, OTP, V1, api, bearer, closeConnections, loginAs, newAdvisor, registerAdvisor, resetDatabase, type Challenge,
} from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

const verify = (challengeId: string, code: string) => api().post(`${V1}/auth/otp/verify`).send({ challengeId, code });
const resend = (challengeId: string) => api().post(`${V1}/auth/otp/request`).send({ challengeId });
const allowResendNow = () => OtpChallenge.updateMany({}, { $set: { resendAvailableAt: new Date(Date.now() - 1000) } });

describe('Register', () => {
  it('creates the account, its organization and default roles, and returns an OTP challenge', async () => {
    const input = newAdvisor({ mobile: '9876500001' }); // 10 digits is accepted and stored as +91
    const res = await api().post(`${V1}/auth/register`).send(input);
    expect(res.status).toBe(201);
    const body = res.body as Challenge;
    expect(body.maskedMobile).toBe('+91 98•••••001');
    expect(body.resendAfterSec).toBe(30);

    const user = await User.findById(body.userId).lean();
    expect(user).toMatchObject({ status: 'PENDING_OTP', mobile: '+919876500001', email: input.email });
    const org = await Organization.findById(user?.orgId).lean();
    expect(org?.ownerUserId?.toString()).toBe(body.userId);
    expect(org?.irdaiNumber).toBe(input.irdaiNumber);
    const roles = await Role.find({ orgId: org?._id }).lean();
    expect(roles.map((r) => r.name).sort()).toEqual(['Advisor', 'Office Staff']);
    // the OTP is never stored in plain text
    const challenge = await OtpChallenge.findById(body.challengeId).lean();
    expect(challenge?.codeHash).not.toContain(OTP);
    expect(challenge?.codeHash).toHaveLength(64);
  });

  it('refuses an email or mobile that already has an account', async () => {
    const dupEmail = await api().post(`${V1}/auth/register`).send(newAdvisor({ email: DEMO.advisor.email }));
    expect(dupEmail.status).toBe(409);
    expect(dupEmail.body.message).toBe('An account with this email already exists. Try logging in.');
    const dupMobile = await api().post(`${V1}/auth/register`).send(newAdvisor({ mobile: DEMO.advisor.mobile }));
    expect(dupMobile.status).toBe(409);
    expect(dupMobile.body.message).toBe('An account with this mobile number already exists. Try logging in.');
  });

  it('applies the same password and field rules as the app', async () => {
    const short = await api().post(`${V1}/auth/register`).send(newAdvisor({ password: 'abc123' }));
    expect(short.status).toBe(400);
    expect(short.body.message).toBe('Password must be at least 8 characters.');
    const noDigit = await api().post(`${V1}/auth/register`).send(newAdvisor({ password: 'abcdefgh' }));
    expect(noDigit.body.message).toBe('Password must contain a letter and a number.');
    const badMobile = await api().post(`${V1}/auth/register`).send(newAdvisor({ mobile: '12345' }));
    expect(badMobile.body.message).toBe('Enter a valid 10-digit Indian mobile number');
    const badEmail = await api().post(`${V1}/auth/register`).send(newAdvisor({ email: 'not-an-email' }));
    expect(badEmail.body.message).toBe('Enter a valid email address');
  });

  it('lets a person register again if the earlier sign-up never verified the OTP', async () => {
    const input = newAdvisor();
    const first = (await api().post(`${V1}/auth/register`).send(input)).body as Challenge;
    const second = await api().post(`${V1}/auth/register`).send({ ...input, name: 'Corrected Name' });
    expect(second.status).toBe(201);
    expect(await User.exists({ _id: first.userId })).toBeNull(); // old unverified account removed
    expect(await Role.countDocuments({ orgId: (await User.findById(second.body.userId).lean())?.orgId })).toBe(2);
  });

  it('blocks login until the OTP is verified', async () => {
    const { input } = await registerAdvisor();
    const res = await api().post(`${V1}/auth/login`).send({ identifier: input.email, password: input.password });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_PENDING_OTP');
  });
});

describe('OTP verification', () => {
  it('counts wrong attempts and locks after 5', async () => {
    const { challenge } = await registerAdvisor();
    const first = await verify(challenge.challengeId, '000000');
    expect(first.status).toBe(400);
    expect(first.body.message).toBe('Incorrect code. 4 attempt(s) left.');
    for (let i = 0; i < 4; i += 1) await verify(challenge.challengeId, '000000');
    const locked = await verify(challenge.challengeId, OTP); // even the right code is refused now
    expect(locked.status).toBe(429);
    expect(locked.body.message).toBe('Too many attempts. Tap "Resend code" to get a new one.');
    // after a resend, the new code works
    await allowResendNow();
    const fresh = await resend(challenge.challengeId);
    expect(fresh.status).toBe(200);
    expect((await verify(fresh.body.challengeId, OTP)).status).toBe(200);
  });

  it('refuses an expired code', async () => {
    const { challenge } = await registerAdvisor();
    await OtpChallenge.updateOne({ _id: challenge.challengeId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await verify(challenge.challengeId, OTP);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('This code has expired. Tap "Resend code".');
  });

  it('only allows a resend after 30 seconds, and the old code stops working', async () => {
    const { challenge } = await registerAdvisor();
    const tooSoon = await resend(challenge.challengeId);
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.code).toBe('OTP_RESEND_TOO_SOON');

    await allowResendNow();
    const next = await resend(challenge.challengeId);
    expect(next.status).toBe(200);
    expect(next.body.challengeId).not.toBe(challenge.challengeId);
    expect((await verify(challenge.challengeId, OTP)).status).toBe(400); // old challenge is dead
    expect((await resend(challenge.challengeId)).body.code).toBe('OTP_CHALLENGE_INVALID');
  });

  it('limits how many codes one account can request per hour', async () => {
    const { challenge } = await registerAdvisor();
    let current = challenge.challengeId;
    for (let i = 0; i < 4; i += 1) {
      await allowResendNow();
      const r = await resend(current);
      expect(r.status).toBe(200);
      current = r.body.challengeId as string;
    }
    await allowResendNow();
    const sixth = await resend(current);
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('OTP_LIMIT_REACHED');
  });

  it('correct code → PENDING_VERIFICATION, trial starts, login still blocked until approval', async () => {
    const { input, challenge } = await registerAdvisor();
    const res = await verify(challenge.challengeId, OTP);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: challenge.userId });
    expect((await verify(challenge.challengeId, OTP)).status).toBe(400); // a code works only once

    const user = await User.findById(challenge.userId).lean();
    expect(user?.status).toBe('PENDING_VERIFICATION');
    expect(user?.mobileVerifiedAt).toBeInstanceOf(Date);
    expect((await Organization.findById(user?.orgId).lean())?.trialStartedAt).toBeInstanceOf(Date);

    const status = await api().get(`${V1}/auth/registrations/${challenge.userId}/status`);
    expect(status.body).toEqual({ status: 'PENDING_VERIFICATION' });

    const login = await api().post(`${V1}/auth/login`).send({ identifier: input.email, password: input.password });
    expect(login.status).toBe(403);
    expect(login.body.message).toBe('Your registration is pending verification. You can log in once it is approved.');
  });
});

describe('Admin approval', () => {
  it('only platform admins can see or approve registrations', async () => {
    const advisor = await loginAs(DEMO.advisor.email);
    expect((await api().get(`${V1}/admin/registrations`).set(bearer(advisor.accessToken))).status).toBe(403);
    expect((await api().get(`${V1}/admin/registrations`)).status).toBe(401);
  });

  it('cannot approve before the mobile is verified', async () => {
    const { challenge } = await registerAdvisor();
    const admin = await loginAs(DEMO.admin.email);
    const res = await api().post(`${V1}/admin/registrations/${challenge.userId}/approve`).set(bearer(admin.accessToken));
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Mobile number is not verified yet.');
  });

  it('lists pending registrations, approves one, and the advisor can then log in with full permissions', async () => {
    const { input, challenge } = await registerAdvisor({ verify: true });
    const admin = await loginAs(DEMO.admin.email);

    const list = await api().get(`${V1}/admin/registrations`).set(bearer(admin.accessToken));
    expect(list.status).toBe(200);
    const row = (list.body.items as { userId: string; irdaiNumber: string }[]).find((i) => i.userId === challenge.userId);
    expect(row?.irdaiNumber).toBe(input.irdaiNumber);

    const ok = await api().post(`${V1}/admin/registrations/${challenge.userId}/approve`).set(bearer(admin.accessToken));
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('ACTIVE');
    const again = await api().post(`${V1}/admin/registrations/${challenge.userId}/approve`).set(bearer(admin.accessToken));
    expect(again.status).toBe(409);

    expect((await api().get(`${V1}/auth/registrations/${challenge.userId}/status`)).body).toEqual({ status: 'ACTIVE' });
    const tokens = await loginAs(input.email, input.password);
    const me = await api().get(`${V1}/auth/me`).set(bearer(tokens.accessToken));
    expect(me.body.roleName).toBe('Advisor');
    expect(me.body.permissions).toHaveLength(ORG_PERMISSIONS.length);
    expect(await AuditLog.exists({ action: 'registration.approve', entityId: challenge.userId })).toBeTruthy();
  });

  it('a rejected advisor cannot log in', async () => {
    const { input, challenge } = await registerAdvisor({ verify: true });
    const admin = await loginAs(DEMO.admin.email);
    const short = await api().post(`${V1}/admin/registrations/${challenge.userId}/reject`).set(bearer(admin.accessToken)).send({ reason: 'no' });
    expect(short.status).toBe(400);
    const res = await api().post(`${V1}/admin/registrations/${challenge.userId}/reject`).set(bearer(admin.accessToken))
      .send({ reason: 'IRDAI number could not be verified' });
    expect(res.body.status).toBe('REJECTED');
    const login = await api().post(`${V1}/auth/login`).send({ identifier: input.email, password: input.password });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('ACCOUNT_REJECTED');
    expect((await api().get(`${V1}/auth/registrations/${challenge.userId}/status`)).body).toEqual({ status: 'REJECTED' });
  });

  it('the status endpoint does not reveal staff accounts or invalid ids', async () => {
    const staff = await User.findOne({ email: DEMO.staff.email }).lean();
    expect((await api().get(`${V1}/auth/registrations/${staff?._id.toString()}/status`)).status).toBe(404);
    expect((await api().get(`${V1}/auth/registrations/not-an-id/status`)).status).toBe(400);
  });
});
