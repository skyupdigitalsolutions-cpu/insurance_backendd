import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Activity } from '../src/modules/activities/activity.model.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { DEMO, V1, api, bearer, closeConnections, freshMobile, registerAdvisor, resetDatabase, tokenOf } from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

const newLead = (overrides: Record<string, unknown> = {}) => ({
  name: 'Kiran Shetty', mobile: freshMobile(), source: 'Paid Ads', requirement: 'Health cover', ...overrides,
});

async function createLead(token: string, overrides: Record<string, unknown> = {}) {
  const res = await api().post(`${V1}/leads`).set(bearer(token)).send(newLead(overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; status: string; mobile: string };
}

async function moveTo(token: string, id: string, ...statuses: string[]) {
  for (const status of statuses) {
    const res = await api().patch(`${V1}/leads/${id}/status`).set(bearer(token)).send({ status });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
}

describe('List and search', () => {
  it('returns the demo leads newest first, with paging info', async () => {
    const res = await api().get(`${V1}/leads`).set(bearer(await tokenOf(DEMO.advisor.email)));
    expect(res.status).toBe(200);
    expect(res.body.items.map((l: { name: string }) => l.name)).toEqual(['Pooja Hegde', 'Rahul Menon', 'Divya Kulkarni']);
    expect(res.body).toMatchObject({ page: 1, limit: 50, total: 3 });
  });

  it('filters by status and searches by name or mobile digits', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const qualified = await api().get(`${V1}/leads`).query({ status: 'QUALIFIED' }).set(bearer(token));
    expect(qualified.body.items.map((l: { name: string }) => l.name)).toEqual(['Divya Kulkarni']);
    const byName = await api().get(`${V1}/leads`).query({ q: 'rahul' }).set(bearer(token));
    expect(byName.body.items).toHaveLength(1);
    const byMobile = await api().get(`${V1}/leads`).query({ q: '98450' }).set(bearer(token));
    expect(byMobile.body.items[0].name).toBe('Pooja Hegde');
    const weird = await api().get(`${V1}/leads`).query({ q: '.*(' }).set(bearer(token)); // regex characters are safe
    expect(weird.status).toBe(200);
    expect(weird.body.items).toHaveLength(0);
  });

  it('lead detail includes the contact history and the allowed next statuses', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const rahul = await Lead.findOne({ name: 'Rahul Menon' }).lean();
    const res = await api().get(`${V1}/leads/${rahul!._id.toString()}`).set(bearer(token));
    expect(res.body.status).toBe('CONTACTED');
    expect(res.body.allowedTransitions).toEqual(['QUALIFIED', 'FOLLOW_UP', 'LOST']);
    expect(res.body.activities[0]).toMatchObject({ type: 'Call', outcome: 'Connected', notes: 'Asked for options by Friday' });
  });
});

describe('Create', () => {
  it('creates a NEW lead, stores the mobile as +91 and logs an event', async () => {
    const token = await tokenOf(DEMO.staff.email); // staff may create leads
    const res = await api().post(`${V1}/leads`).set(bearer(token)).send(newLead({ mobile: '9123400001', email: 'Kiran@Example.com' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: 'NEW', mobile: '+919123400001', email: 'kiran@example.com', activities: [] });
    expect(await Activity.exists({ entityId: res.body.id, text: 'New lead: Kiran Shetty (Paid Ads)' })).toBeTruthy();
  });

  it('refuses a second lead with the same mobile, and the duplicate check finds it', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const dup = await api().post(`${V1}/leads`).set(bearer(token)).send(newLead({ mobile: '+919845012345' }));
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe('A lead with this mobile number already exists.');
    const check = await api().post(`${V1}/leads/duplicate-check`).set(bearer(token)).send({ mobile: '9845012345' });
    expect(check.body.match.name).toBe('Pooja Hegde');
    const none = await api().post(`${V1}/leads/duplicate-check`).set(bearer(token)).send({ mobile: '9999988888' });
    expect(none.body.match).toBeNull();
  });

  it('a Referral lead needs an active referral code of the same advisor', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const missing = await api().post(`${V1}/leads`).set(bearer(token)).send(newLead({ source: 'Referral' }));
    expect(missing.body.message).toBe('Enter the referral code.');
    const wrong = await api().post(`${V1}/leads`).set(bearer(token)).send(newLead({ source: 'Referral', referralCode: 'NOPE1' }));
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toBe('Referral code is not active.');
    const ok = await api().post(`${V1}/leads`).set(bearer(token)).send(newLead({ source: 'Referral', referralCode: 'ref200' }));
    expect(ok.status).toBe(201);
    expect(ok.body.referralCode).toBe('REF200');
  });

  it('validates the fields', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const res = await api().post(`${V1}/leads`).set(bearer(token)).send({ name: 'K', mobile: '12345', source: 'TV' });
    expect(res.status).toBe(400);
    expect(res.body.details.map((d: { path: string }) => d.path).sort()).toEqual(['mobile', 'name', 'source']);
  });
});

describe('Status machine and activities', () => {
  it('only allows the defined moves, and LOST needs a reason', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const lead = await createLead(token);
    const skip = await api().patch(`${V1}/leads/${lead.id}/status`).set(bearer(token)).send({ status: 'QUOTATION' });
    expect(skip.status).toBe(400);
    expect(skip.body.message).toBe('Cannot move lead from NEW to QUOTATION.');

    const noReason = await api().patch(`${V1}/leads/${lead.id}/status`).set(bearer(token)).send({ status: 'LOST' });
    expect(noReason.body.message).toBe('A reason is required to mark a lead as lost.');
    const lost = await api().patch(`${V1}/leads/${lead.id}/status`).set(bearer(token)).send({ status: 'LOST', reason: 'Bought elsewhere' });
    expect(lost.body).toMatchObject({ status: 'LOST', lostReason: 'Bought elsewhere' });

    const reopened = await api().patch(`${V1}/leads/${lead.id}/status`).set(bearer(token)).send({ status: 'NEW' });
    expect(reopened.body.status).toBe('NEW');
    expect(reopened.body.lostReason).toBeUndefined();
  });

  it('logging the first contact moves NEW → CONTACTED', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const lead = await createLead(token);
    const res = await api().post(`${V1}/leads/${lead.id}/activities`).set(bearer(token))
      .send({ type: 'WhatsApp', outcome: 'Connected', notes: 'Sent brochure' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('CONTACTED');
    expect(res.body.activities[0]).toMatchObject({ type: 'WhatsApp', outcome: 'Connected', notes: 'Sent brochure' });
    const bad = await api().post(`${V1}/leads/${lead.id}/activities`).set(bearer(token)).send({ type: 'Fax', outcome: '' });
    expect(bad.status).toBe(400);
  });

  it('office staff cannot change leads if their role does not allow it', async () => {
    const owner = await tokenOf(DEMO.advisor.email);
    const lead = await createLead(owner);
    const advisorRoles = await api().get(`${V1}/roles`).set(bearer(owner));
    const staffRole = advisorRoles.body.items.find((r: { name: string }) => r.name === 'Office Staff');
    await api().patch(`${V1}/roles/${staffRole.id}`).set(bearer(owner)).send({ name: 'Office Staff', permissions: ['lead:read'] });
    const staff = await tokenOf(DEMO.staff.email);
    expect((await api().patch(`${V1}/leads/${lead.id}/status`).set(bearer(staff)).send({ status: 'CONTACTED' })).status).toBe(403);
    expect((await api().post(`${V1}/leads`).set(bearer(staff)).send(newLead())).status).toBe(403);
    expect((await api().get(`${V1}/leads`).set(bearer(staff))).status).toBe(200);
  });
});

describe('Convert to customer', () => {
  it('needs a qualified lead, creates the customer once, and links it', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const lead = await createLead(token, { name: 'Meena Iyer', email: 'meena@example.com', source: 'Campaign', campaign: 'Diwali 2026' });
    const early = await api().post(`${V1}/leads/${lead.id}/convert`).set(bearer(token));
    expect(early.status).toBe(400);
    expect(early.body.message).toBe('Qualify the lead before converting it to a customer.');

    await moveTo(token, lead.id, 'CONTACTED', 'QUALIFIED');
    const res = await api().post(`${V1}/leads/${lead.id}/convert`).set(bearer(token));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Meena Iyer', mobile: lead.mobile, email: 'meena@example.com', source: 'Campaign', leadId: lead.id, consentGiven: false });

    const again = await api().post(`${V1}/leads/${lead.id}/convert`).set(bearer(token));
    expect(again.status).toBe(409);
    expect(again.body.message).toBe('This lead is already converted.');
    const detail = await api().get(`${V1}/leads/${lead.id}`).set(bearer(token));
    expect(detail.body.customerId).toBe(res.body.id);
  });

  it('reuses an existing customer with the same mobile instead of creating a duplicate', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const lead = await createLead(token, { mobile: '+919812345678' }); // Sneha Rao is already a customer
    await moveTo(token, lead.id, 'CONTACTED', 'QUALIFIED');
    const res = await api().post(`${V1}/leads/${lead.id}/convert`).set(bearer(token));
    expect(res.body.name).toBe('Sneha Rao');
    expect(await Customer.countDocuments({ mobile: '+919812345678' })).toBe(1);
  });

  it('two convert requests at the same moment create only one customer', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const lead = await createLead(token);
    await moveTo(token, lead.id, 'CONTACTED', 'QUALIFIED');
    const [a, b] = await Promise.all([
      api().post(`${V1}/leads/${lead.id}/convert`).set(bearer(token)),
      api().post(`${V1}/leads/${lead.id}/convert`).set(bearer(token)),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await Customer.countDocuments({ mobile: lead.mobile })).toBe(1);
  });
});

describe('Organization isolation', () => {
  it('another advisor sees none of these leads and cannot open or change them', async () => {
    const { input } = await registerAdvisor({ approve: true });
    const other = await tokenOf(input.email, input.password);
    const list = await api().get(`${V1}/leads`).set(bearer(other));
    expect(list.body.items).toHaveLength(0);
    const pooja = await Lead.findOne({ name: 'Pooja Hegde' }).lean();
    const id = pooja!._id.toString();
    expect((await api().get(`${V1}/leads/${id}`).set(bearer(other))).status).toBe(404);
    expect((await api().patch(`${V1}/leads/${id}/status`).set(bearer(other)).send({ status: 'CONTACTED' })).status).toBe(404);
    // the same mobile number is allowed as a lead for a different advisor
    expect((await api().post(`${V1}/leads`).set(bearer(other)).send(newLead({ mobile: '+919845012345' }))).status).toBe(201);
    // their referral codes are separate too
    expect((await api().post(`${V1}/leads`).set(bearer(other)).send(newLead({ source: 'Referral', referralCode: 'REF100' }))).status).toBe(400);
  });
});
