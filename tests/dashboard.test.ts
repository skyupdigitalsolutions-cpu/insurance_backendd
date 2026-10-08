import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO, V1, api, bearer, closeConnections, customerId, productId, resetDatabase, setDemoPlan, tokenOf } from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

describe('Dashboard summary', () => {
  it('counts per period in India time, renewals due and customers', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const today = await api().get(`${V1}/dashboard/summary`).query({ range: 'today' }).set(bearer(token));
    expect(today.body).toMatchObject({ totalLeads: 1, newLeads: 1, activeCustomers: 2, renewalsDue: 2, quotes: 0, paid: 0, policies: 0 });
    const month30 = await api().get(`${V1}/dashboard/summary`).query({ range: '30d' }).set(bearer(token));
    expect(month30.body).toMatchObject({ totalLeads: 3, newLeads: 1, contacted: 2, qualified: 1 });
  });
});

describe('Pending actions', () => {
  it('overdue first, each with a target the app can open', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    await api().post(`${V1}/quotations`).set(bearer(token)).send({
      customerId: await customerId('Ravi Kumar'), productId: await productId('Family Health Optima'),
      addOnIds: [], frequency: 'Yearly', discountPercent: 15, discountReason: 'Loyal', comparedProductIds: [],
    });
    const res = await api().get(`${V1}/dashboard/pending-actions`).query({ limit: 5 }).set(bearer(token));
    const items = res.body.items as { type: string; title: string; isOverdue: boolean; target: string; targetId: string }[];
    expect(items[0]).toMatchObject({ type: 'followup', title: 'Collect PAN copy', isOverdue: true, target: 'task' });
    const approval = items.find((i) => i.type === 'approval')!;
    expect(approval.title).toMatch(/^Approve 15% discount on Q-\d{4}-\d{5}$/);
    expect(approval.target).toBe('quote');
    expect(approval.targetId).toMatch(/^[a-f\d]{24}$/);
  });
});

describe('KPI report', () => {
  it('funnel and rates with the specification formulas, no division by zero', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const res = await api().get(`${V1}/reports/kpis`).set(bearer(token));
    expect(res.body.funnel.map((f: { value: number }) => f.value)).toEqual([3, 2, 1, 0, 0, 0, 0]); // no lead has been converted and quoted yet
    const rates = res.body.rates as { label: string; value: string }[];
    const rate = (label: string) => rates.find((r) => r.label === label)?.value;
    expect(rate('Contact rate')).toBe('67%');
    expect(rate('Payment conversion')).toBe('—');
  });

  it('needs the report permission and an active plan', async () => {
    expect((await api().get(`${V1}/reports/kpis`).set(bearer(await tokenOf(DEMO.staff.email)))).status).toBe(403);
    await setDemoPlan('pro', { expired: true });
    const expired = await api().get(`${V1}/reports/kpis`).set(bearer(await tokenOf(DEMO.advisor.email)));
    expect(expired.status).toBe(403);
    expect(expired.body.message).toBe('Your plan has expired. Renew it in Subscription to continue.');
    await setDemoPlan('pro');
  });
});
