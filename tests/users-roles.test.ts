import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../src/modules/roles/role.model.js';
import { User } from '../src/modules/users/user.model.js';
import { DEMO, V1, api, bearer, closeConnections, loginAs, registerAdvisor, resetDatabase } from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

type AppUser = { id: string; email: string; roleName: string; active: boolean; temporaryPassword?: string };
type RoleRow = { id: string; name: string; permissions: string[]; system: boolean };

async function advisorToken() {
  return (await loginAs(DEMO.advisor.email)).accessToken;
}
async function roleId(name: string) {
  const owner = await User.findOne({ email: DEMO.advisor.email }).lean();
  return (await Role.findOne({ orgId: owner?.orgId, name }).lean())!._id.toString();
}

describe('Permissions', () => {
  it('office staff cannot manage users or roles', async () => {
    const staff = await loginAs(DEMO.staff.email);
    const res = await api().get(`${V1}/users`).set(bearer(staff.accessToken));
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("You don't have permission to do this.");
    expect((await api().post(`${V1}/roles`).set(bearer(staff.accessToken)).send({ name: 'X', permissions: ['lead:read'] })).status).toBe(403);
  });

  it('a platform admin has no access to an advisor’s users', async () => {
    const admin = await loginAs(DEMO.admin.email);
    expect((await api().get(`${V1}/users`).set(bearer(admin.accessToken))).status).toBe(403);
  });
});

describe('Users', () => {
  it('lists users of my organization only', async () => {
    const res = await api().get(`${V1}/users`).set(bearer(await advisorToken()));
    expect(res.status).toBe(200);
    const emails = (res.body.items as AppUser[]).map((u) => u.email).sort();
    expect(emails).toEqual([DEMO.advisor.email, DEMO.staff.email]);
    expect(res.body.items[0]).toMatchObject({ roleName: 'Advisor', active: true });
  });

  it('adds a staff user with a one-time temporary password that must be changed', async () => {
    const res = await api().post(`${V1}/users`).set(bearer(await advisorToken()))
      .send({ name: 'Ravi Kumar', email: 'ravi@example.com', mobile: '9800000001', roleId: await roleId('Office Staff') });
    expect(res.status).toBe(201);
    const created = res.body as AppUser;
    expect(created).toMatchObject({ email: 'ravi@example.com', roleName: 'Office Staff', active: true });
    expect(created.temporaryPassword).toMatch(/^[A-Za-z]{6}\d{4}$/);

    const tokens = await loginAs('ravi@example.com', created.temporaryPassword);
    expect(tokens.mustChangePassword).toBe(true);
    // the list never shows passwords
    const list = await api().get(`${V1}/users`).set(bearer(await advisorToken()));
    expect(JSON.stringify(list.body)).not.toContain('temporaryPassword');
    expect(JSON.stringify(list.body)).not.toContain('passwordHash');
  });

  it('refuses duplicates, the Advisor role, and roles from another organization', async () => {
    const token = await advisorToken();
    const dup = await api().post(`${V1}/users`).set(bearer(token))
      .send({ name: 'Copy', email: DEMO.staff.email, mobile: '9800000002', roleId: await roleId('Office Staff') });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe('A user with this email or mobile already exists.');

    const owner = await api().post(`${V1}/users`).set(bearer(token))
      .send({ name: 'Second Owner', email: 'owner2@example.com', mobile: '9800000003', roleId: await roleId('Advisor') });
    expect(owner.status).toBe(400);

    const other = await registerAdvisor({ approve: true });
    const otherUser = await User.findById(other.challenge.userId).lean();
    const foreignRole = await Role.findOne({ orgId: otherUser?.orgId, name: 'Office Staff' }).lean();
    const foreign = await api().post(`${V1}/users`).set(bearer(token))
      .send({ name: 'Foreign', email: 'foreign@example.com', mobile: '9800000004', roleId: foreignRole!._id.toString() });
    expect(foreign.status).toBe(400);
    expect(foreign.body.message).toBe('Choose a valid role.');
  });

  it('deactivating a user logs them out immediately and blocks login', async () => {
    const token = await advisorToken();
    const staff = await loginAs(DEMO.staff.email);
    const staffId = (await User.findOne({ email: DEMO.staff.email }).lean())!._id.toString();

    const res = await api().patch(`${V1}/users/${staffId}`).set(bearer(token)).send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect((await api().get(`${V1}/auth/me`).set(bearer(staff.accessToken))).status).toBe(401);
    const login = await api().post(`${V1}/auth/login`).send({ identifier: DEMO.staff.email, password: 'Demo@1234' });
    expect(login.status).toBe(403);
    expect(login.body.message).toBe('This account is inactive. Contact your advisor.');

    await api().patch(`${V1}/users/${staffId}`).set(bearer(token)).send({ active: true });
    await loginAs(DEMO.staff.email);
  });

  it('protects the account owner and cannot touch users of another organization', async () => {
    const token = await advisorToken();
    const ownerId = (await User.findOne({ email: DEMO.advisor.email }).lean())!._id.toString();
    const self = await api().patch(`${V1}/users/${ownerId}`).set(bearer(token)).send({ active: false });
    expect(self.status).toBe(400);

    const other = await registerAdvisor({ approve: true });
    const res = await api().patch(`${V1}/users/${other.challenge.userId}`).set(bearer(token)).send({ active: false });
    expect(res.status).toBe(404);
  });
});

describe('Roles', () => {
  it('lists the default roles with the Advisor role marked as system', async () => {
    const res = await api().get(`${V1}/roles`).set(bearer(await advisorToken()));
    const roles = res.body.items as RoleRow[];
    expect(roles.find((r) => r.name === 'Advisor')?.system).toBe(true);
    expect(roles.find((r) => r.name === 'Office Staff')?.system).toBe(false);
  });

  it('creates a role and refuses duplicates, unknown permissions and empty lists', async () => {
    const token = await advisorToken();
    const ok = await api().post(`${V1}/roles`).set(bearer(token)).send({ name: 'Telecaller', permissions: ['lead:read', 'lead:update', 'lead:read'] });
    expect(ok.status).toBe(201);
    expect(ok.body.permissions).toEqual(['lead:read', 'lead:update']);

    const dup = await api().post(`${V1}/roles`).set(bearer(token)).send({ name: 'telecaller', permissions: ['lead:read'] });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe('A role with this name already exists.');

    const unknown = await api().post(`${V1}/roles`).set(bearer(token)).send({ name: 'Hacker', permissions: ['platform:registration:approve'] });
    expect(unknown.status).toBe(400);
    const empty = await api().post(`${V1}/roles`).set(bearer(token)).send({ name: 'Empty', permissions: [] });
    expect(empty.body.message).toBe('Choose at least one permission.');
  });

  it('the Advisor role cannot be edited', async () => {
    const res = await api().patch(`${V1}/roles/${await roleId('Advisor')}`).set(bearer(await advisorToken()))
      .send({ name: 'Advisor', permissions: ['lead:read'] });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('The Advisor role cannot be changed.');
  });

  it('editing a role changes what its users can do right away', async () => {
    const token = await advisorToken();
    const staff = await loginAs(DEMO.staff.email);
    expect((await api().get(`${V1}/users`).set(bearer(staff.accessToken))).status).toBe(403);

    const edit = await api().patch(`${V1}/roles/${await roleId('Office Staff')}`).set(bearer(token))
      .send({ name: 'Office Staff', permissions: ['dashboard:read', 'user:manage'] });
    expect(edit.status).toBe(200);
    expect((await api().get(`${V1}/users`).set(bearer(staff.accessToken))).status).toBe(200); // same token, new rights
    const me = await api().get(`${V1}/auth/me`).set(bearer(staff.accessToken));
    expect(me.body.permissions).toEqual(['dashboard:read', 'user:manage']);
  });
});
