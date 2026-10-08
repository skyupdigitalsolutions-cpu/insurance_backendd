import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Consent } from '../src/modules/customers/related.models.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { DEMO, V1, api, bearer, closeConnections, freshMobile, registerAdvisor, resetDatabase, tokenOf } from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

const idOf = async (name: string) => (await Customer.findOne({ name }).lean())!._id.toString();

async function newCustomer(token: string, overrides: Record<string, unknown> = {}) {
  const res = await api().post(`${V1}/customers`).set(bearer(token)).send({ name: 'Anil Gowda', mobile: freshMobile(), ...overrides });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string };
}

describe('Customers', () => {
  it('lists A–Z and searches', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const res = await api().get(`${V1}/customers`).set(bearer(token));
    expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(['Ravi Kumar', 'Sneha Rao']);
    const q = await api().get(`${V1}/customers`).query({ q: 'sneha' }).set(bearer(token));
    expect(q.body.items).toHaveLength(1);
  });

  it('creates a customer with validated fields and default source', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const res = await api().post(`${V1}/customers`).set(bearer(token))
      .send({ name: 'Farah Khan', mobile: '9811100001', email: '', dob: '1990-02-28', city: 'Hubballi', pin: '580020' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ mobile: '+919811100001', source: 'Direct', consentGiven: false, dob: '1990-02-28' });
    expect(res.body.email).toBeUndefined();
  });

  it('refuses a duplicate mobile, impossible dates and bad PIN codes', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const dup = await api().post(`${V1}/customers`).set(bearer(token)).send({ name: 'Copy', mobile: '+919876543210' });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe('A customer with this mobile number already exists.');
    const feb30 = await api().post(`${V1}/customers`).set(bearer(token)).send({ name: 'Date Test', mobile: freshMobile(), dob: '1990-02-30' });
    expect(feb30.body.message).toBe('Enter a real date');
    const future = await api().post(`${V1}/customers`).set(bearer(token)).send({ name: 'Date Test', mobile: freshMobile(), dob: '2999-01-01' });
    expect(future.body.message).toBe('Date cannot be in the future');
    const pin = await api().post(`${V1}/customers`).set(bearer(token)).send({ name: 'Pin Test', mobile: freshMobile(), pin: '012345' });
    expect(pin.body.message).toBe('Enter a valid 6-digit PIN code');
  });

  it('records consent with server time and keeps a consent record', async () => {
    const token = await tokenOf(DEMO.staff.email);
    const id = await idOf('Sneha Rao');
    const before = Date.now();
    const res = await api().post(`${V1}/customers/${id}/consents`).set(bearer(token)).send({ purpose: 'data-processing' });
    expect(res.status).toBe(201);
    expect(res.body.consentGiven).toBe(true);
    expect(new Date(res.body.consentAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    const record = await Consent.findOne({ customerId: id }).lean();
    expect(record).toMatchObject({ purpose: 'data-processing' });
    expect(record?.recordedBy).toBeTruthy();
  });
});

describe('Family and nominees', () => {
  it('adds family members with a valid relationship', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const id = await idOf('Ravi Kumar');
    const ok = await api().post(`${V1}/customers/${id}/family`).set(bearer(token)).send({ name: 'Kamala Kumar', relationship: 'Mother', dob: '1960-07-15' });
    expect(ok.status).toBe(201);
    const list = await api().get(`${V1}/customers/${id}/family`).set(bearer(token));
    expect(list.body.items.map((f: { name: string }) => f.name)).toEqual(['Lakshmi Kumar', 'Aarav Kumar', 'Kamala Kumar']);
    const bad = await api().post(`${V1}/customers/${id}/family`).set(bearer(token)).send({ name: 'X Y', relationship: 'Neighbour' });
    expect(bad.body.message).toBe('Choose a relationship');
  });

  it('keeps the nominee total at or below 100 %', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const c = await newCustomer(token);
    const add = (percent: number, name = 'Nominee One') =>
      api().post(`${V1}/customers/${c.id}/nominees`).set(bearer(token)).send({ name, relationship: 'Spouse', percent });

    expect((await add(60)).status).toBe(201);
    const over = await add(50, 'Nominee Two');
    expect(over.status).toBe(400);
    expect(over.body.message).toBe('Total allocation would be 110%. It cannot exceed 100%.');
    const second = await add(40, 'Nominee Two');
    expect(second.status).toBe(201);

    // remove one → its share is free again
    expect((await api().delete(`${V1}/nominees/${second.body.id}`).set(bearer(token))).status).toBe(204);
    expect((await add(40, 'Nominee Three')).status).toBe(201);
    const list = await api().get(`${V1}/customers/${c.id}/nominees`).set(bearer(token));
    expect(list.body.items.reduce((s: number, n: { percent: number }) => s + n.percent, 0)).toBe(100);
  });

  it('parallel nominee additions cannot exceed 100 % together', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const c = await newCustomer(token);
    const results = await Promise.all([60, 60, 60].map((percent, i) =>
      api().post(`${V1}/customers/${c.id}/nominees`).set(bearer(token)).send({ name: `Parallel ${i} Name`, relationship: 'Son', percent })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await Customer.findById(c.id).lean())?.nomineePercentTotal).toBe(60);
  });

  it('refuses shares outside 1–100 and decimals', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const c = await newCustomer(token);
    for (const percent of [0, 101, 12.5]) {
      const r = await api().post(`${V1}/customers/${c.id}/nominees`).set(bearer(token)).send({ name: 'Bad Share', relationship: 'Son', percent });
      expect(r.status).toBe(400);
    }
  });
});

describe('Need analysis', () => {
  it('is null until saved, then saved and replaced', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const id = await idOf('Sneha Rao');
    expect((await api().get(`${V1}/customers/${id}/need-analysis`).set(bearer(token))).body).toBeNull();

    const first = await api().put(`${V1}/customers/${id}/need-analysis`).set(bearer(token))
      .send({ insuranceType: 'Health', need: 'Family floater', coverage: 1000000, budget: 25000, members: 3 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ customerId: id, insuranceType: 'Health', coverage: 1000000, members: 3 });

    const second = await api().put(`${V1}/customers/${id}/need-analysis`).set(bearer(token)).send({ insuranceType: 'Life', need: 'Term plan' });
    expect(second.body).toMatchObject({ insuranceType: 'Life', need: 'Term plan' });
    expect(second.body.coverage).toBeUndefined();

    const bad = await api().put(`${V1}/customers/${id}/need-analysis`).set(bearer(token)).send({ insuranceType: 'Health', need: 'x', budget: -5 });
    expect(bad.body.message).toBe('Budget cannot be negative');
  });
});

describe('Organization isolation', () => {
  it('another advisor cannot see or change these customers', async () => {
    const { input } = await registerAdvisor({ approve: true });
    const other = await tokenOf(input.email, input.password);
    expect((await api().get(`${V1}/customers`).set(bearer(other))).body.items).toHaveLength(0);
    const ravi = await idOf('Ravi Kumar');
    expect((await api().get(`${V1}/customers/${ravi}`).set(bearer(other))).status).toBe(404);
    expect((await api().get(`${V1}/customers/${ravi}/family`).set(bearer(other))).status).toBe(404);
    expect((await api().post(`${V1}/customers/${ravi}/consents`).set(bearer(other)).send({})).status).toBe(404);
    const owner = await tokenOf(DEMO.advisor.email);
    const nominees = await api().get(`${V1}/customers/${ravi}/nominees`).set(bearer(owner));
    expect((await api().delete(`${V1}/nominees/${nominees.body.items[0].id}`).set(bearer(other))).status).toBe(404);
  });
});
