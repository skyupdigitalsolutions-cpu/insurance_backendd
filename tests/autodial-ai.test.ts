import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startOfIndianDay, todayInIndia } from '../src/lib/dates.js';
import { Task } from '../src/modules/tasks/task.model.js';
import { DEMO, V1, api, bearer, closeConnections, customerId, policyIdOf, resetDatabase, tokenOf } from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

type Item = { kind: string; refId: string; name: string; subtitle: string };

describe('Autodial', () => {
  it('builds the three call lists in a useful order', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const q = async (list: string) => (await api().get(`${V1}/autodial/queue`).query({ list }).set(bearer(token))).body.items as Item[];
    expect((await q('new_leads')).map((i) => i.name)).toEqual(['Pooja Hegde']);
    expect((await q('open_leads')).map((i) => i.name)).toEqual(['Divya Kulkarni', 'Rahul Menon']); // oldest first
    const renewals = await q('renewals');
    expect(renewals.map((i) => i.name)).toEqual(['Ravi Kumar', 'Sneha Rao']);
    expect(renewals[0]!.subtitle).toBe('Family Health Optima · due in 5 days');
  });

  it('saves the outcome on the lead or renewal; "Call back" adds a task for tomorrow 10:00 India time', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const [pooja] = (await api().get(`${V1}/autodial/queue`).query({ list: 'new_leads' }).set(bearer(token))).body.items as Item[];
    const res = await api().post(`${V1}/autodial/calls`).set(bearer(token))
      .send({ kind: 'lead', refId: pooja!.refId, outcome: 'Call back', notes: 'In a meeting', durationSec: 42 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Pooja Hegde', outcome: 'Call back', durationSec: 42 });
    expect((await api().get(`${V1}/leads/${pooja!.refId}`).set(bearer(token))).body.status).toBe('CONTACTED');
    const task = await Task.findOne({ title: 'Call back Pooja Hegde' }).lean();
    expect(task?.due.toISOString()).toBe(new Date(startOfIndianDay(todayInIndia(1)).getTime() + 10 * 3_600_000).toISOString());

    const policy = await policyIdOf('POL-2025-01127');
    await api().post(`${V1}/autodial/calls`).set(bearer(token)).send({ kind: 'renewal', refId: policy, outcome: 'Connected', durationSec: 120 });
    expect((await api().get(`${V1}/renewals/${policy}`).set(bearer(token))).body.status).toBe('Contacted');
    expect((await api().get(`${V1}/autodial/calls`).set(bearer(token))).body.items).toHaveLength(2);
  });

  it('staff cannot log renewal calls without the renewal permission', async () => {
    const staff = await tokenOf(DEMO.staff.email);
    const res = await api().post(`${V1}/autodial/calls`).set(bearer(staff)).send({ kind: 'renewal', refId: await policyIdOf('POL-2025-00418'), outcome: 'Busy' });
    expect(res.status).toBe(403);
  });
});

describe('AI recommendations', () => {
  it('need analysis first; then eligible products with reasons from real data', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const ravi = await customerId('Ravi Kumar');
    expect((await api().post(`${V1}/ai/recommendations`).set(bearer(token)).send({ customerId: ravi })).body.message).toBe('Save the need analysis first.');
    await api().put(`${V1}/customers/${ravi}/need-analysis`).set(bearer(token)).send({ insuranceType: 'Health', need: 'Family floater', budget: 18000 });
    const res = await api().post(`${V1}/ai/recommendations`).set(bearer(token)).send({ customerId: ravi });
    const items = res.body.items as { product: { name: string }; reasons: string[]; warnings: string[] }[];
    expect(items.map((i) => i.product.name)).toEqual(['Health Guard Gold', 'Family Health Optima', 'Care Supreme']);
    expect(items[0]!.reasons).toContain('Premium fits the budget of ₹18,000');
    expect(items[1]!.warnings).toContain('Premium is above the stated budget');
    expect(items[2]!.warnings).toEqual(['Premium not available – confirm with insurer', 'Eligibility not available', 'No source document recorded for this product']);
  });
});
