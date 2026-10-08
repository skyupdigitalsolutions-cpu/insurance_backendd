import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Invoice, Subscription } from '../src/modules/subscription/subscription.model.js';
import { User } from '../src/modules/users/user.model.js';
import {
  DEMO, V1, api, bearer, closeConnections, customerId, demoOrgId, freshMobile, registerAdvisor, resetDatabase, setDemoPlan, tokenOf,
} from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

const pay = (url: string) => api().post(new URL(url).pathname).type('form').send({ result: 'success' });

describe('My subscription', () => {
  it('shows the plan, features, invoices, and who may change it', async () => {
    const owner = await api().get(`${V1}/subscription`).set(bearer(await tokenOf(DEMO.advisor.email)));
    expect(owner.body).toMatchObject({ status: 'ACTIVE', cycle: 'monthly', autoRenew: true, isOwner: true });
    expect(owner.body.plan.id).toBe('pro');
    expect(owner.body.features).toContain('autodial');
    expect(owner.body.invoices).toHaveLength(2);
    const staff = await api().get(`${V1}/subscription`).set(bearer(await tokenOf(DEMO.staff.email)));
    expect(staff.body.isOwner).toBe(false);
    expect((await api().get(`${V1}/subscription/plans`)).body.items).toHaveLength(3); // public: shown during sign-up
  });

  it('a new advisor starts on a 14-day trial with every feature; an expired trial loses premium features', async () => {
    const { input, challenge } = await registerAdvisor({ approve: true });
    const token = await tokenOf(input.email, input.password);
    const sub = await api().get(`${V1}/subscription`).set(bearer(token));
    expect(sub.body).toMatchObject({ status: 'TRIAL', daysLeft: 14 });
    expect(sub.body.features).toContain('ai');

    const orgId = (await User.findById(challenge.userId).lean())!.orgId;
    await Subscription.updateOne({ orgId }, { $set: { currentPeriodEnd: new Date(Date.now() - 1000) } });
    const expired = await api().get(`${V1}/subscription`).set(bearer(token));
    expect(expired.body).toMatchObject({ status: 'EXPIRED', features: [] });
    expect((await api().get(`${V1}/autodial/queue`).query({ list: 'new_leads' }).set(bearer(token))).body.message)
      .toBe('Your plan has expired. Renew it in Subscription to continue.');
  });
});

describe('Buying a plan', () => {
  it('only the owner; not the same plan again', async () => {
    const staff = await api().post(`${V1}/subscription/checkout`).set(bearer(await tokenOf(DEMO.staff.email))).send({ planId: 'basic', cycle: 'yearly' });
    expect(staff.status).toBe(403);
    expect(staff.body.message).toBe('Only the account owner can change the plan.');
    const same = await api().post(`${V1}/subscription/checkout`).set(bearer(await tokenOf(DEMO.advisor.email))).send({ planId: 'pro', cycle: 'monthly' });
    expect(same.body.message).toBe('You are already on this plan.');
  });

  it('paying activates the plan once, with an 18 % GST invoice', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const checkout = await api().post(`${V1}/subscription/checkout`).set(bearer(token)).send({ planId: 'basic', cycle: 'yearly' });
    expect(checkout.status).toBe(201);
    expect(checkout.body).toMatchObject({ planName: 'Basic', amount: 4990, gst: 898, total: 5888, status: 'PENDING' });

    await pay(checkout.body.url as string);
    await pay(checkout.body.url as string); // repeated confirmation
    expect((await api().get(`${V1}/subscription/checkout/${checkout.body.checkoutId}`).set(bearer(token))).body.status).toBe('PAID');
    const sub = await api().get(`${V1}/subscription`).set(bearer(token));
    expect(sub.body).toMatchObject({ status: 'ACTIVE', cycle: 'yearly' });
    expect(sub.body.plan.id).toBe('basic');
    expect(sub.body.daysLeft).toBeGreaterThanOrEqual(364);
    expect(await Invoice.countDocuments({ orgId: await demoOrgId() })).toBe(3);
    expect(sub.body.invoices[0]).toMatchObject({ planName: 'Basic', total: 5888 });
  });
});

describe('Plan limits are enforced by the server', () => {
  it('Basic: no AI, no Autodial, one user; reports still work', async () => {
    await setDemoPlan('basic');
    const token = await tokenOf(DEMO.advisor.email);
    const ai = await api().post(`${V1}/ai/recommendations`).set(bearer(token)).send({ customerId: await customerId('Ravi Kumar') });
    expect(ai.status).toBe(403);
    expect(ai.body.message).toBe("Your current plan doesn't include AI recommendations. Upgrade to Pro to use it.");
    expect((await api().get(`${V1}/autodial/queue`).query({ list: 'renewals' }).set(bearer(token))).body.message)
      .toBe("Your current plan doesn't include Autodial. Upgrade to Pro to use it.");
    expect((await api().get(`${V1}/reports/kpis`).set(bearer(token))).status).toBe(200);

    const roles = (await api().get(`${V1}/roles`).set(bearer(token))).body.items as { id: string; name: string }[];
    const add = await api().post(`${V1}/users`).set(bearer(token))
      .send({ name: 'Extra Person', email: 'extra@example.com', mobile: freshMobile(), roleId: roles.find((r) => r.name === 'Office Staff')!.id });
    expect(add.status).toBe(403);
    expect(add.body.message).toBe('Your plan allows 1 user. Upgrade to Pro to add more.');
    await setDemoPlan('pro');
  });

  it('auto-renew can be switched on paid plans only', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    expect((await api().patch(`${V1}/subscription`).set(bearer(token)).send({ autoRenew: false })).body.autoRenew).toBe(false);
    await setDemoPlan('trial');
    expect((await api().patch(`${V1}/subscription`).set(bearer(token)).send({ autoRenew: true })).body.message).toBe('Auto-renew applies to paid plans only.');
    await setDemoPlan('pro');
  });
});
