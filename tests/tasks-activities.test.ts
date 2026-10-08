import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO, V1, api, bearer, closeConnections, freshMobile, registerAdvisor, resetDatabase, tokenOf } from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

describe('Tasks', () => {
  it('lists tasks earliest due first (overdue on top)', async () => {
    const res = await api().get(`${V1}/tasks`).set(bearer(await tokenOf(DEMO.staff.email)));
    expect(res.status).toBe(200);
    expect(res.body.items.map((t: { title: string }) => t.title)).toEqual([
      'Collect PAN copy', 'Call Rahul about term plan options', 'Visit for renewal discussion',
    ]);
  });

  it('creates a task in the future and refuses one in the past', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const ok = await api().post(`${V1}/tasks`).set(bearer(token))
      .send({ title: 'Send quotation', type: 'Payment follow-up', due: inHours(5), relatedTo: 'Customer: Ravi Kumar' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ title: 'Send quotation', done: false, relatedTo: 'Customer: Ravi Kumar' });
    const past = await api().post(`${V1}/tasks`).set(bearer(token)).send({ title: 'Too late', type: 'Call', due: inHours(-2) });
    expect(past.status).toBe(400);
    expect(past.body.message).toBe('Due date and time must be in the future.');
    const noTitle = await api().post(`${V1}/tasks`).set(bearer(token)).send({ title: ' ', type: 'Call', due: inHours(1) });
    expect(noTitle.body.message).toBe('Title is required.');
    const badDate = await api().post(`${V1}/tasks`).set(bearer(token)).send({ title: 'Bad date', type: 'Call', due: 'tomorrow' });
    expect(badDate.body.message).toBe('Choose a valid due date and time');
  });

  it('marks done / not done and filters', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const list = await api().get(`${V1}/tasks`).set(bearer(token));
    const id = list.body.items[0].id as string;
    expect((await api().patch(`${V1}/tasks/${id}`).set(bearer(token)).send({ done: true })).body.done).toBe(true);
    const open = await api().get(`${V1}/tasks`).query({ status: 'open' }).set(bearer(token));
    expect(open.body.items.some((t: { id: string }) => t.id === id)).toBe(false);
    const done = await api().get(`${V1}/tasks`).query({ status: 'done' }).set(bearer(token));
    expect(done.body.items.map((t: { id: string }) => t.id)).toContain(id);
    expect((await api().patch(`${V1}/tasks/${id}`).set(bearer(token)).send({ done: false })).body.done).toBe(false);
  });

  it('tasks of another advisor are invisible and cannot be changed', async () => {
    const { input } = await registerAdvisor({ approve: true });
    const other = await tokenOf(input.email, input.password);
    expect((await api().get(`${V1}/tasks`).set(bearer(other))).body.items).toHaveLength(0);
    const list = await api().get(`${V1}/tasks`).set(bearer(await tokenOf(DEMO.advisor.email)));
    expect((await api().patch(`${V1}/tasks/${list.body.items[0].id}`).set(bearer(other)).send({ done: true })).status).toBe(404);
  });
});

describe('Recent activity (dashboard)', () => {
  it('shows the latest events newest first, limited to 5 by default', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const lead = await api().post(`${V1}/leads`).set(bearer(token)).send({ name: 'Activity Check', mobile: freshMobile(), source: 'Other' });
    await api().post(`${V1}/leads/${lead.body.id}/activities`).set(bearer(token)).send({ type: 'Call', outcome: 'No answer' });

    const res = await api().get(`${V1}/activities`).query({ scope: 'recent', limit: 5 }).set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.items[0].text).toBe('Call with Activity Check: No answer');
    expect(res.body.items[1].text).toBe('New lead: Activity Check (Other)');
    expect(Object.keys(res.body.items[0]).sort()).toEqual(['id', 'text', 'time']);
  });

  it('needs dashboard permission and is per organization', async () => {
    const { input } = await registerAdvisor({ approve: true });
    const other = await tokenOf(input.email, input.password);
    expect((await api().get(`${V1}/activities`).set(bearer(other))).body.items).toHaveLength(0);
    expect((await api().get(`${V1}/activities`)).status).toBe(401);
  });
});
