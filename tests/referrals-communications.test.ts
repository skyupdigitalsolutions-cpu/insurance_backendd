import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Template } from '../src/modules/communications/communication.models.js';
import { DEMO, V1, api, bearer, closeConnections, customerId, freshMobile, resetDatabase, tokenOf } from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

const referral = (o: Record<string, unknown>) => ({ name: 'Kavya Shetty', mobile: freshMobile(), relationship: 'Friend', interest: 'Health', ...o });

describe('Referrals', () => {
  it('creates a lead with the referral locked on it; status follows the lead', async () => {
    const token = await tokenOf(DEMO.staff.email);
    const res = await api().post(`${V1}/referrals`).set(bearer(token)).send(referral({ referrerCustomerId: await customerId('Ravi Kumar') }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ referrerName: 'Ravi Kumar', status: 'Assigned' });
    const lead = await api().get(`${V1}/leads/${res.body.leadId}`).set(bearer(token));
    expect(lead.body).toMatchObject({ source: 'Referral', requirement: 'Health insurance', notes: 'Referred by Ravi Kumar (Friend)' });

    const owner = await tokenOf(DEMO.advisor.email);
    await api().patch(`${V1}/leads/${res.body.leadId}/status`).set(bearer(owner)).send({ status: 'LOST', reason: 'Not interested' });
    const list = await api().get(`${V1}/referrals`).set(bearer(token));
    expect(list.body.items.find((r: { id: string }) => r.id === res.body.id).status).toBe('Rejected');
  });

  it('accepts an active code, refuses inactive codes, missing referrer and duplicate mobiles', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const byCode = await api().post(`${V1}/referrals`).set(bearer(token)).send(referral({ code: 'ref100' }));
    expect(byCode.body).toMatchObject({ referrerName: 'Code REF100', code: 'REF100' });
    expect((await api().post(`${V1}/referrals`).set(bearer(token)).send(referral({ code: 'NOPE' }))).body.message).toBe('Referral code is not active.');
    expect((await api().post(`${V1}/referrals`).set(bearer(token)).send(referral({}))).body.message).toBe('Choose the referring customer or enter a referral code.');
    const dup = await api().post(`${V1}/referrals`).set(bearer(token)).send(referral({ code: 'REF100', mobile: '+919845012345' }));
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe('A lead with this mobile number already exists.');
  });
});

describe('Communications', () => {
  it('lists approved templates only and previews with real data', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    await Template.create({ name: 'Draft promo', event: 'Promo', channel: 'WhatsApp', body: 'x', approved: false });
    const templates = (await api().get(`${V1}/templates`).set(bearer(token))).body.items as { id: string; name: string }[];
    expect(templates.map((t) => t.name).sort()).toEqual(['Birthday wishes', 'Payment received', 'Quotation follow-up', 'Renewal reminder']);
    const renewal = templates.find((t) => t.name === 'Renewal reminder')!;
    const preview = await api().post(`${V1}/communications/preview`).set(bearer(token)).send({ templateId: renewal.id, customerId: await customerId('Ravi Kumar') });
    expect(preview.body.text).toMatch(/^Dear Ravi, your policy POL-2025-00418 is due for renewal on \d{2} [A-Z][a-z]{2} \d{4}\./);
  });

  it('WhatsApp needs consent, email needs an address; sent messages are listed', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const templates = (await api().get(`${V1}/templates`).set(bearer(token))).body.items as { id: string; name: string }[];
    const wa = templates.find((t) => t.name === 'Birthday wishes')!.id;
    const mail = templates.find((t) => t.name === 'Quotation follow-up')!.id;
    const sneha = await customerId('Sneha Rao');
    expect((await api().post(`${V1}/communications/send`).set(bearer(token)).send({ customerId: sneha, templateId: wa })).body.message)
      .toBe('Sneha Rao has not given consent for WhatsApp messages.');
    expect((await api().post(`${V1}/communications/send`).set(bearer(token)).send({ customerId: sneha, templateId: mail })).body.message)
      .toBe('Sneha Rao has no email address.');

    const sent = await api().post(`${V1}/communications/send`).set(bearer(token)).send({ customerId: await customerId('Ravi Kumar'), templateId: wa });
    expect(sent.status).toBe(201);
    expect(sent.body).toMatchObject({ customerName: 'Ravi Kumar', channel: 'WhatsApp', status: 'Sent', text: 'Happy birthday Ravi! Wishing you good health and happiness.' });
    expect((await api().get(`${V1}/communications`).set(bearer(token))).body.items).toHaveLength(1);
  });

  it('staff without the send permission cannot use messaging', async () => {
    const staff = await tokenOf(DEMO.staff.email);
    expect((await api().get(`${V1}/templates`).set(bearer(staff))).status).toBe(403);
  });
});
