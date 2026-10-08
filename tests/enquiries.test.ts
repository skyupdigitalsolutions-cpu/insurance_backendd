// Website contact form and the admin view of enquiries
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Enquiry } from '../src/modules/enquiries/enquiry.model.js';
import { DEMO, V1, api, bearer, closeConnections, resetDatabase, tokenOf } from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

const valid = { name: 'Kiran Rao', mobile: '9845012345', email: 'kiran@example.com', city: 'Mysuru', message: 'I run a small agency with 2 staff. Please call me.', consent: true };

describe('Website enquiries', () => {
  it('stores a valid enquiry without login', async () => {
    const res = await api().post(`${V1}/public/enquiries`).send(valid);
    expect(res.status).toBe(201);
    expect(await Enquiry.findOne({ name: 'Kiran Rao' }).lean()).toMatchObject({ mobile: '+919845012345', status: 'NEW', city: 'Mysuru' });
  });

  it('needs consent, a real mobile and a message; bots filling the hidden field are ignored', async () => {
    expect((await api().post(`${V1}/public/enquiries`).send({ ...valid, consent: false })).status).toBe(400);
    expect((await api().post(`${V1}/public/enquiries`).send({ ...valid, mobile: '12345' })).status).toBe(400);
    expect((await api().post(`${V1}/public/enquiries`).send({ ...valid, message: 'hi' })).status).toBe(400);
    const bot = await api().post(`${V1}/public/enquiries`).send({ ...valid, name: 'Spam Bot', website: 'http://spam.example' });
    expect(bot.status).toBe(201);
    expect(await Enquiry.exists({ name: 'Spam Bot' })).toBeNull();
  });

  it('platform admins list enquiries and mark them contacted; advisors cannot', async () => {
    const admin = bearer(await tokenOf(DEMO.admin.email));
    const list = await api().get(`${V1}/admin/enquiries`).set(admin);
    expect(list.body.total).toBe(1);
    const id = list.body.items[0].id as string;
    const done = await api().patch(`${V1}/admin/enquiries/${id}`).set(admin).send({ status: 'CONTACTED' });
    expect(done.body.status).toBe('CONTACTED');
    expect((await api().get(`${V1}/admin/enquiries`).query({ status: 'NEW' }).set(admin)).body.total).toBe(0);
    expect((await api().get(`${V1}/admin/enquiries`).set(bearer(await tokenOf(DEMO.advisor.email)))).status).toBe(403);
  });
});
