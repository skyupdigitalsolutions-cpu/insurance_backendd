// Part 5: web admin panel endpoints (overview, advisors, audit, background jobs) and the job queue wiring.
import { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JOBS, isJobName } from '../src/jobs/definitions.js';
import { QUEUE_NAME, QUEUE_PREFIX, queueConnection } from '../src/jobs/queue.js';
import { DEMO, V1, api, bearer, closeConnections, registerAdvisor, resetDatabase, tokenOf } from './helpers.js';

let worker: Worker | undefined;
beforeAll(resetDatabase);
afterAll(async () => {
  await worker?.close();
  await closeConnections();
});

const admin = async () => bearer(await tokenOf(DEMO.admin.email));

describe('Admin panel: access', () => {
  it('only platform admins can open the admin views', async () => {
    const advisor = bearer(await tokenOf(DEMO.advisor.email));
    for (const path of ['/admin/overview', '/admin/advisors', '/admin/audit', '/admin/jobs']) {
      expect((await api().get(`${V1}${path}`).set(advisor)).status, path).toBe(403);
      expect((await api().get(`${V1}${path}`)).status, path).toBe(401);
    }
    expect((await api().post(`${V1}/admin/jobs/expire-quotes/run`).set(advisor)).status).toBe(403);
  });
});

describe('Admin panel: overview, advisors, audit', () => {
  it('overview shows platform numbers and health', async () => {
    await registerAdvisor({ verify: true }); // one waiting for approval
    const res = await api().get(`${V1}/admin/overview`).set(await admin());
    expect(res.status).toBe(200);
    expect(res.body.advisors).toMatchObject({ active: 1, pendingApproval: 1 });
    expect(res.body.plans.pro).toBe(1);
    expect(res.body.products.active).toBeGreaterThan(0);
    expect(res.body.policies.active).toBe(3);
    expect(res.body.health).toMatchObject({ api: true, mongo: true, redis: true });
  });

  it('advisors list with plan and size, searchable, mobile masked', async () => {
    const res = await api().get(`${V1}/admin/advisors`).query({ q: 'Demo' }).set(await admin());
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.items[0]).toMatchObject({ name: DEMO.advisor.name, plan: 'Pro', planStatus: 'ACTIVE', users: 2, activePolicies: 3, customers: 2 });
    expect(res.body.items[0].mobile).toContain('•');
  });

  it('audit log, newest first, filterable by action', async () => {
    const all = await api().get(`${V1}/admin/audit`).set(await admin());
    expect(all.status).toBe(200);
    expect(all.body.total).toBeGreaterThan(0);
    const logins = await api().get(`${V1}/admin/audit`).query({ action: 'auth.login' }).set(await admin());
    expect((logins.body.items as { action: string }[]).every((i) => i.action.startsWith('auth.login'))).toBe(true);
    expect(logins.body.items[0].actor).toBeTypeOf('string');
  });
});

describe('Background jobs through the queue', () => {
  it('lists every job; "Run now" is processed by the worker and the result is shown', async () => {
    const list = await api().get(`${V1}/admin/jobs`).set(await admin());
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(Object.keys(JOBS).length);
    expect(list.body.workersOnline).toBe(0);

    const finished = new Promise<void>((resolve) => {
      worker = new Worker(QUEUE_NAME, async (job) => (isJobName(job.name) ? JOBS[job.name].run() : null), { connection: queueConnection(), prefix: QUEUE_PREFIX });
      worker.on('completed', () => resolve());
    });
    const run = await api().post(`${V1}/admin/jobs/expire-quotes/run`).set(await admin());
    expect(run.status).toBe(202);
    expect(run.body).toMatchObject({ name: 'expire-quotes' });
    await finished;

    const after = await api().get(`${V1}/admin/jobs`).set(await admin());
    const job = (after.body.items as { name: string; lastRun: Record<string, unknown> | null }[]).find((j) => j.name === 'expire-quotes')!;
    expect(job.lastRun).toMatchObject({ status: 'completed', manual: true, result: { expiredQuotes: 0 } });
    expect(after.body.workersOnline).toBe(1);

    expect((await api().post(`${V1}/admin/jobs/drop-database/run`).set(await admin())).status).toBe(400);
  });
});
