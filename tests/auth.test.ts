import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Session } from '../src/modules/auth/session.model.js';
import { ORG_PERMISSIONS, STAFF_ROLE } from '../src/modules/roles/permissions.js';
import { DEMO, PASSWORD, V1, api, bearer, closeConnections, loginAs, resetDatabase } from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

describe('Login', () => {
  it('logs in the advisor with email and returns both tokens', async () => {
    const res = await api().post(`${V1}/auth/login`).send({ identifier: 'DEMO@test.com ', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, mustChangePassword: false });
    expect(typeof res.body.accessToken).toBe('string');
    expect(typeof res.body.refreshToken).toBe('string');
  });

  it('logs in with a 10-digit mobile number', async () => {
    const tokens = await loginAs('9000000100');
    expect(tokens.accessToken).toBeTruthy();
  });

  it('gives the same message for a wrong password and an unknown account', async () => {
    const wrong = await api().post(`${V1}/auth/login`).send({ identifier: DEMO.advisor.email, password: 'nope1234' });
    const unknown = await api().post(`${V1}/auth/login`).send({ identifier: 'nobody@example.com', password: 'nope1234' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.message).toBe('Email/mobile or password is incorrect');
    expect(unknown.body.message).toBe(wrong.body.message);
    expect(wrong.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects an empty body with a readable validation message', async () => {
    const res = await api().post(`${V1}/auth/login`).send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(typeof res.body.message).toBe('string');
    expect(res.body.requestId).toBeTruthy();
  });
});

describe('GET /auth/me', () => {
  it('returns the advisor with every organization permission', async () => {
    const { accessToken } = await loginAs(DEMO.advisor.email);
    const res = await api().get(`${V1}/auth/me`).set(bearer(accessToken));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: DEMO.advisor.name, email: DEMO.advisor.email, roleName: 'Advisor', isPlatformAdmin: false });
    expect([...res.body.permissions].sort()).toEqual([...ORG_PERMISSIONS].sort());
  });

  it('returns only the Office Staff permissions for staff', async () => {
    const { accessToken } = await loginAs(DEMO.staff.email);
    const res = await api().get(`${V1}/auth/me`).set(bearer(accessToken));
    expect(res.body.roleName).toBe('Office Staff');
    expect([...res.body.permissions].sort()).toEqual([...STAFF_ROLE.permissions].sort());
    expect(res.body.permissions).not.toContain('user:manage');
  });

  it('refuses a missing, malformed or forged token', async () => {
    expect((await api().get(`${V1}/auth/me`)).status).toBe(401);
    expect((await api().get(`${V1}/auth/me`).set(bearer('not-a-jwt'))).status).toBe(401);
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMiLCJzaWQiOiIxMjMifQ.c2lnbmF0dXJl';
    expect((await api().get(`${V1}/auth/me`).set(bearer(forged))).status).toBe(401);
  });
});

describe('Refresh token rotation', () => {
  it('gives a new pair and the new access token works', async () => {
    const first = await loginAs(DEMO.advisor.email);
    const res = await api().post(`${V1}/auth/refresh`).send({ refreshToken: first.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(first.refreshToken);
    expect((await api().get(`${V1}/auth/me`).set(bearer(res.body.accessToken))).status).toBe(200);
  });

  it('answers REFRESH_IN_PROGRESS (without logging out) when two refreshes race', async () => {
    const first = await loginAs(DEMO.advisor.email);
    const a = await api().post(`${V1}/auth/refresh`).send({ refreshToken: first.refreshToken });
    const b = await api().post(`${V1}/auth/refresh`).send({ refreshToken: first.refreshToken });
    expect(a.status).toBe(200);
    expect(b.status).toBe(401);
    expect(b.body.code).toBe('REFRESH_IN_PROGRESS');
    // the session from the winning refresh still works
    expect((await api().post(`${V1}/auth/refresh`).send({ refreshToken: a.body.refreshToken })).status).toBe(200);
  });

  it('ends the session when an old refresh token is reused later (stolen token)', async () => {
    const first = await loginAs(DEMO.advisor.email);
    const rotated = await api().post(`${V1}/auth/refresh`).send({ refreshToken: first.refreshToken });
    // pretend the rotation happened 5 minutes ago (outside the 30 s grace period)
    await Session.updateMany({ rotatedAt: { $ne: null } }, { $set: { rotatedAt: new Date(Date.now() - 5 * 60_000) } });

    const reuse = await api().post(`${V1}/auth/refresh`).send({ refreshToken: first.refreshToken });
    expect(reuse.status).toBe(401);
    // the legitimate new tokens are now dead too
    expect((await api().post(`${V1}/auth/refresh`).send({ refreshToken: rotated.body.refreshToken })).status).toBe(401);
    expect((await api().get(`${V1}/auth/me`).set(bearer(rotated.body.accessToken))).status).toBe(401);
  });

  it('refuses an unknown refresh token', async () => {
    const res = await api().post(`${V1}/auth/refresh`).send({ refreshToken: 'x'.repeat(64) });
    expect(res.status).toBe(401);
  });
});

describe('Logout and password change', () => {
  it('logout stops the access token and the refresh token at once', async () => {
    const t = await loginAs(DEMO.advisor.email);
    expect((await api().post(`${V1}/auth/logout`).set(bearer(t.accessToken))).status).toBe(204);
    expect((await api().get(`${V1}/auth/me`).set(bearer(t.accessToken))).status).toBe(401);
    expect((await api().post(`${V1}/auth/refresh`).send({ refreshToken: t.refreshToken })).status).toBe(401);
  });

  it('changes the password and logs out other devices', async () => {
    const phone = await loginAs(DEMO.staff.email);
    const tablet = await loginAs(DEMO.staff.email);

    const wrong = await api().post(`${V1}/auth/change-password`).set(bearer(phone.accessToken))
      .send({ currentPassword: 'wrong-pass1', newPassword: 'NewPass123' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe('Current password is incorrect.');

    const weak = await api().post(`${V1}/auth/change-password`).set(bearer(phone.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);

    const ok = await api().post(`${V1}/auth/change-password`).set(bearer(phone.accessToken))
      .send({ currentPassword: PASSWORD, newPassword: 'NewPass123' });
    expect(ok.status).toBe(204);
    expect((await api().get(`${V1}/auth/me`).set(bearer(phone.accessToken))).status).toBe(200); // this device stays in
    expect((await api().get(`${V1}/auth/me`).set(bearer(tablet.accessToken))).status).toBe(401); // other device is out
    await loginAs(DEMO.staff.email, 'NewPass123');
  });
});
