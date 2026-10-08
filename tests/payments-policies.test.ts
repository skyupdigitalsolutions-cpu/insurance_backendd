import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Payment } from '../src/modules/payments/payment.model.js';
import { Policy } from '../src/modules/policies/policy.model.js';
import { todayInIndia } from '../src/lib/dates.js';
import {
  DEMO, FILES, V1, api, bearer, closeConnections, customerId, productId, registerAdvisor, resetDatabase, tokenOf,
} from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

// A quotation for Ravi that is sent and accepted
async function acceptedQuote(token: string) {
  const q = await api().post(`${V1}/quotations`).set(bearer(token)).send({
    customerId: await customerId('Ravi Kumar'), productId: await productId('Family Health Optima'),
    addOnIds: [], frequency: 'Yearly', discountPercent: 0, comparedProductIds: [],
  });
  await api().post(`${V1}/quotations/${q.body.id}/send`).set(bearer(token)).send({});
  await api().post(`${V1}/quotations/${q.body.id}/accept`).set(bearer(token));
  return q.body as { id: string; quoteNumber: string; pricing: { total: number } };
}
const linkOf = (token: string, quoteId: string) => api().post(`${V1}/quotations/${quoteId}/payment-link`).set(bearer(token)).send({ method: 'UPI' });
// The customer taps a button on the practice checkout page
const pay = (link: string, result: 'success' | 'fail') => api().post(new URL(link).pathname).type('form').send({ result });

describe('Payment link', () => {
  it('only after acceptance; asking twice returns the same payment', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const q = await api().post(`${V1}/quotations`).set(bearer(token)).send({
      customerId: await customerId('Ravi Kumar'), productId: await productId('Health Guard Gold'), addOnIds: [], frequency: 'Yearly', discountPercent: 0, comparedProductIds: [],
    });
    expect((await linkOf(token, q.body.id)).body.message).toBe('Payment can be requested only after the customer accepts.');

    const accepted = await acceptedQuote(token);
    const first = await linkOf(token, accepted.id);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: 'PENDING', amount: accepted.pricing.total, method: 'UPI', quoteNumber: accepted.quoteNumber });
    expect(first.body.link).toMatch(/\/pay\/mock_/);
    const second = await linkOf(token, accepted.id);
    expect(second.body.id).toBe(first.body.id);
    expect((await api().get(`${V1}/quotations/${accepted.id}`).set(bearer(token))).body.status).toBe('PAYMENT_PENDING');
  });

  it('three taps at the same moment create one payment', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const q = await acceptedQuote(token);
    const results = await Promise.all([linkOf(token, q.id), linkOf(token, q.id), linkOf(token, q.id)]);
    expect(await Payment.countDocuments({ quotationId: q.id })).toBe(1);
    expect(results.filter((r) => r.status === 201).every((r) => r.body.id === results.find((x) => x.status === 201)!.body.id)).toBe(true);
  });
});

describe('Paying (practice checkout = same path as the Razorpay webhook)', () => {
  it('success → payment SUCCESS, quotation PAID, one policy waiting for issuance', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const q = await acceptedQuote(token);
    const payment = (await linkOf(token, q.id)).body as { id: string; link: string };

    const page = await api().get(new URL(payment.link).pathname);
    expect(page.status).toBe(200);
    expect(page.text).toContain(`₹${q.pricing.total.toLocaleString('en-IN')}`);

    expect((await pay(payment.link, 'success')).text).toContain('Payment successful');
    const paid = await api().get(`${V1}/payments/${payment.id}`).set(bearer(token));
    expect(paid.body).toMatchObject({ status: 'SUCCESS' });
    expect(paid.body.transactionRef).toMatch(/^pay_MOCK/);
    expect((await api().get(`${V1}/quotations/${q.id}`).set(bearer(token))).body.status).toBe('PAID');

    // paying again (or a repeated webhook) changes nothing
    await pay(payment.link, 'success');
    expect(await Policy.countDocuments({ quotationId: q.id })).toBe(1);
    const policies = await api().get(`${V1}/policies`).query({ quotationId: q.id }).set(bearer(token));
    expect(policies.body.items[0]).toMatchObject({ status: 'PENDING_ISSUANCE', premium: q.pricing.total, customerName: 'Ravi Kumar' });
    expect((await linkOf(token, q.id)).body.message).toBe('This quotation is already paid.');
  });

  it('failure → FAILED; retry gives a new link that can then be paid', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const q = await acceptedQuote(token);
    const payment = (await linkOf(token, q.id)).body as { id: string; link: string };
    expect((await api().post(`${V1}/payments/${payment.id}/retry`).set(bearer(token))).body.message).toBe('Only failed payments can be retried.');

    await pay(payment.link, 'fail');
    expect((await api().get(`${V1}/payments/${payment.id}`).set(bearer(token))).body.status).toBe('FAILED');
    const retried = await api().post(`${V1}/payments/${payment.id}/retry`).set(bearer(token));
    expect(retried.body.status).toBe('PENDING');
    expect(retried.body.link).not.toBe(payment.link);
    await pay(retried.body.link as string, 'success');
    expect((await api().get(`${V1}/payments/${payment.id}`).set(bearer(token))).body.status).toBe('SUCCESS');
  });

  it('a link past its expiry shows as failed', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const q = await acceptedQuote(token);
    const payment = (await linkOf(token, q.id)).body as { id: string };
    await Payment.updateOne({ _id: payment.id }, { $set: { linkExpiresAt: new Date(Date.now() - 1000) } });
    const res = await api().get(`${V1}/payments/${payment.id}`).set(bearer(token));
    expect(res.body).toMatchObject({ status: 'FAILED', failureReason: 'Payment link expired' });
  });

  it('payments list is per organization', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    expect((await api().get(`${V1}/payments`).set(bearer(token))).body.items.length).toBeGreaterThan(2);
    const { input } = await registerAdvisor({ approve: true });
    const other = await tokenOf(input.email, input.password);
    expect((await api().get(`${V1}/payments`).set(bearer(other))).body.items).toHaveLength(0);
  });
});

describe('Policy issuance', () => {
  it('blocked until every checklist item passes, then issued once with dates and a number', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const q = await acceptedQuote(token);
    const payment = (await linkOf(token, q.id)).body as { link: string };
    await pay(payment.link, 'success');
    const policy = (await api().get(`${V1}/policies`).query({ quotationId: q.id }).set(bearer(token))).body.items[0] as { id: string };

    const checklist = await api().get(`${V1}/policies/${policy.id}/issuance-checklist`).set(bearer(token));
    expect(checklist.body.items.filter((i: { passed: boolean }) => !i.passed).map((i: { key: string }) => i.key)).toEqual(['kyc']);
    const blocked = await api().post(`${V1}/policies/${policy.id}/issue`).set(bearer(token));
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toBe('Cannot issue: KYC document verified.');

    // upload + verify a KYC document, then issue
    const ravi = await customerId('Ravi Kumar');
    const doc = await api().post(`${V1}/customers/${ravi}/documents`).set(bearer(token)).field('type', 'Aadhaar').attach('file', FILES.jpg, 'a.jpg');
    await api().post(`${V1}/documents/${doc.body.id}/review`).set(bearer(token)).send({ decision: 'VERIFY' });

    const staff = await tokenOf(DEMO.staff.email);
    expect((await api().post(`${V1}/policies/${policy.id}/issue`).set(bearer(staff))).status).toBe(403);

    const issued = await api().post(`${V1}/policies/${policy.id}/issue`).set(bearer(token));
    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe('ACTIVE');
    expect(issued.body.policyNumber).toMatch(/^POL-\d{4}-00001$/);
    expect(issued.body.startDate).toBe(todayInIndia());
    const end = new Date(`${issued.body.startDate as string}T00:00:00Z`);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    end.setUTCDate(end.getUTCDate() - 1);
    expect(issued.body.endDate).toBe(end.toISOString().slice(0, 10));

    const again = await api().post(`${V1}/policies/${policy.id}/issue`).set(bearer(token));
    expect(again.body.policyNumber).toBe(issued.body.policyNumber);
    const customerPolicies = await api().get(`${V1}/policies`).query({ customerId: ravi }).set(bearer(token));
    expect(customerPolicies.body.items.some((p: { id: string; status: string }) => p.id === policy.id && p.status === 'ACTIVE')).toBe(true);
  });

  it('two issue requests at the same moment give one policy number', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const q = await acceptedQuote(token);
    await pay(((await linkOf(token, q.id)).body as { link: string }).link, 'success');
    const policy = (await api().get(`${V1}/policies`).query({ quotationId: q.id }).set(bearer(token))).body.items[0] as { id: string };
    const [a, b] = await Promise.all([
      api().post(`${V1}/policies/${policy.id}/issue`).set(bearer(token)),
      api().post(`${V1}/policies/${policy.id}/issue`).set(bearer(token)),
    ]);
    expect(a.body.policyNumber).toBe(b.body.policyNumber);
  });

  it('another advisor cannot see or issue these policies', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const mine = (await api().get(`${V1}/policies`).set(bearer(token))).body.items[0] as { id: string };
    const { input } = await registerAdvisor({ approve: true });
    const other = await tokenOf(input.email, input.password);
    expect((await api().get(`${V1}/policies/${mine.id}`).set(bearer(other))).status).toBe(404);
    expect((await api().post(`${V1}/policies/${mine.id}/issue`).set(bearer(other))).status).toBe(404);
  });
});
