import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Policy } from '../src/modules/policies/policy.model.js';
import {
  DEMO, V1, api, bearer, closeConnections, customerId, policyIdOf, productId, registerAdvisor, resetDatabase, tokenOf,
} from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

type R = { id: string; customerName: string; status: string; daysLeft: number; insurer: string; contacts: { outcome: string }[] };

describe('Renewal lists', () => {
  it('shows due and overdue policies with days left, soonest first', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const due30 = (await api().get(`${V1}/renewals`).query({ window: '30d' }).set(bearer(token))).body.items as R[];
    expect(due30.map((r) => [r.customerName, r.daysLeft, r.status])).toEqual([['Ravi Kumar', 5, 'Upcoming'], ['Sneha Rao', 20, 'Upcoming']]);
    const due7 = (await api().get(`${V1}/renewals`).query({ window: '7d', limit: 5 }).set(bearer(token))).body.items as R[];
    expect(due7).toHaveLength(1);
    expect(due7[0]!.insurer).toBe('Star Health'); // dashboard card field
    const overdue = (await api().get(`${V1}/renewals`).query({ window: 'overdue' }).set(bearer(token))).body.items as R[];
    expect(overdue.map((r) => [r.customerName, r.daysLeft, r.status])).toEqual([['Ravi Kumar', -2, 'Overdue']]);
    expect((await api().get(`${V1}/renewals`).query({ window: 'all' }).set(bearer(token))).body.items).toHaveLength(3);
  });
});

describe('Working a renewal', () => {
  it('a logged call makes it Contacted; closing needs a reason and removes it from overdue', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const id = await policyIdOf('POL-2025-00090'); // overdue car policy
    const contact = await api().post(`${V1}/renewals/${id}/activities`).set(bearer(token)).send({ outcome: 'Call back', notes: 'Busy today' });
    expect(contact.status).toBe(201);
    expect(contact.body.contacts[0]).toMatchObject({ outcome: 'Call back', notes: 'Busy today' });

    const noReason = await api().patch(`${V1}/renewals/${id}/status`).set(bearer(token)).send({ status: 'CLOSED', reason: ' ' });
    expect(noReason.body.message).toBe('A reason is required to close a renewal.');
    const closed = await api().patch(`${V1}/renewals/${id}/status`).set(bearer(token)).send({ status: 'CLOSED', reason: 'Sold the car' });
    expect(closed.body).toMatchObject({ status: 'Closed', closedReason: 'Sold the car' });
    expect((await api().get(`${V1}/renewals`).query({ window: 'overdue' }).set(bearer(token))).body.items).toHaveLength(0);
  });

  it('a new quotation for the same cover makes it Quoted; a newer policy makes it Renewed', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const sneha = await customerId('Sneha Rao');
    await api().post(`${V1}/customers/${sneha}/consents`).set(bearer(token)).send({});
    await api().post(`${V1}/quotations`).set(bearer(token)).send({
      customerId: sneha, productId: await productId('Health Guard Gold'), addOnIds: [], frequency: 'Yearly', discountPercent: 0, comparedProductIds: [],
    });
    const snehaPolicy = await policyIdOf('POL-2025-01127');
    expect((await api().get(`${V1}/renewals/${snehaPolicy}`).set(bearer(token))).body.status).toBe('Quoted');

    const old = await Policy.findOne({ policyNumber: 'POL-2025-00418' }).lean();
    await Policy.create({ ...old, _id: undefined, policyNumber: 'POL-2026-77777', quotationId: new Types.ObjectId(), createdAt: new Date(), source: 'IMPORTED' });
    const renewed = await api().get(`${V1}/renewals/${old!._id.toString()}`).set(bearer(token));
    expect(renewed.body.status).toBe('Renewed');
    const close = await api().patch(`${V1}/renewals/${old!._id.toString()}/status`).set(bearer(token)).send({ status: 'CLOSED', reason: 'x' });
    expect(close.body.message).toBe('This policy is already renewed.');
  });

  it('staff can see renewals but not work them; other advisors see nothing', async () => {
    const staff = await tokenOf(DEMO.staff.email);
    const id = await policyIdOf('POL-2025-01127');
    expect((await api().get(`${V1}/renewals/${id}`).set(bearer(staff))).status).toBe(200);
    expect((await api().post(`${V1}/renewals/${id}/activities`).set(bearer(staff)).send({ outcome: 'Connected' })).status).toBe(403);
    const { input } = await registerAdvisor({ approve: true });
    const other = await tokenOf(input.email, input.password);
    expect((await api().get(`${V1}/renewals`).query({ window: 'all' }).set(bearer(other))).body.items).toHaveLength(0);
    expect((await api().get(`${V1}/renewals/${id}`).set(bearer(other))).status).toBe(404);
  });
});
