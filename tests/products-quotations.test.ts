import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Customer } from '../src/modules/customers/customer.model.js';
import { Quotation } from '../src/modules/quotations/quotation.model.js';
import {
  DEMO, V1, addOnId, api, bearer, closeConnections, customerId, pathOf, productId, registerAdvisor, resetDatabase, tokenOf,
} from './helpers.js';

beforeAll(resetDatabase);
afterAll(closeConnections);

const quote = (overrides: Record<string, unknown> = {}) => ({ addOnIds: [], frequency: 'Yearly', discountPercent: 0, comparedProductIds: [], ...overrides });

async function newQuote(token: string, overrides: Record<string, unknown> = {}) {
  const res = await api().post(`${V1}/quotations`).set(bearer(token))
    .send(quote({ customerId: await customerId('Ravi Kumar'), productId: await productId('Family Health Optima'), ...overrides }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; quoteNumber: string; status: string; pricing: { total: number }; approvalStatus: string; pdfUrl: string };
}

describe('Products and comparison', () => {
  it('lists active products, filters by type, shows "not available" as null', async () => {
    const token = await tokenOf(DEMO.staff.email);
    const all = await api().get(`${V1}/products`).set(bearer(token));
    expect(all.body.items).toHaveLength(6);
    const health = await api().get(`${V1}/products`).query({ insuranceType: 'Health' }).set(bearer(token));
    expect(health.body.items.map((p: { name: string }) => p.name).sort()).toEqual(['Care Supreme', 'Family Health Optima', 'Health Guard Gold']);
    const care = health.body.items.find((p: { name: string }) => p.name === 'Care Supreme');
    expect(care).toMatchObject({ basePremium: null, eligibility: null, source: null });
  });

  it('compares 2–3 products of the same type only', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const [a, b, life] = await Promise.all([productId('Family Health Optima'), productId('Health Guard Gold'), productId('Click 2 Protect Life')]);
    expect((await api().post(`${V1}/comparisons`).set(bearer(token)).send({ productIds: [a, b] })).body.items).toHaveLength(2);
    expect((await api().post(`${V1}/comparisons`).set(bearer(token)).send({ productIds: [a] })).body.message).toBe('Choose 2 or 3 products to compare.');
    expect((await api().post(`${V1}/comparisons`).set(bearer(token)).send({ productIds: [a, life] })).body.message)
      .toBe('Only products of the same insurance type can be compared.');
  });
});

describe('Pricing (server only)', () => {
  it('health: base + add-ons − discount, no GST (exempt since Sep 2025)', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const res = await api().post(`${V1}/quotations/calculate`).set(bearer(token)).send(quote({
      customerId: await customerId('Ravi Kumar'), productId: await productId('Family Health Optima'),
      addOnIds: [await addOnId('Family Health Optima', 'Critical illness cover')], discountPercent: 5,
    }));
    expect(res.status).toBe(200);
    // 18450 + 3200 = 21650; 5% = 1083; GST 0 → 20567
    expect(res.body).toEqual({ pricing: { base: 18450, addOns: 3200, subtotal: 21650, discount: 1083, gst: 0, total: 20567 }, needsApproval: false });
  });

  it('motor: 18 % GST; monthly = (yearly × 1.04) / 12', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const body = { customerId: await customerId('Ravi Kumar'), productId: await productId('Car Secure Comprehensive'), addOnIds: [await addOnId('Car Secure Comprehensive', 'Zero depreciation')] };
    const yearly = await api().post(`${V1}/quotations/calculate`).set(bearer(token)).send(quote(body));
    // 9320 + 2100 = 11420; GST 18% = 2056 → 13476
    expect(yearly.body.pricing).toEqual({ base: 9320, addOns: 2100, subtotal: 11420, discount: 0, gst: 2056, total: 13476 });
    const monthly = await api().post(`${V1}/quotations/calculate`).set(bearer(token)).send(quote({ ...body, frequency: 'Monthly' }));
    expect(monthly.body.pricing.total).toBe(Math.round((13476 * 1.04) / 12));
  });

  it('refuses unknown add-ons, unpriced products, out-of-range discounts and ineligible ages', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const ravi = await customerId('Ravi Kumar');
    const optima = await productId('Family Health Optima');
    const wrongAddOn = await api().post(`${V1}/quotations/calculate`).set(bearer(token))
      .send(quote({ customerId: ravi, productId: optima, addOnIds: [await addOnId('Car Secure Comprehensive', 'Engine protect')] }));
    expect(wrongAddOn.body.message).toBe('One of the add-ons does not belong to this product.');
    const noPrice = await api().post(`${V1}/quotations/calculate`).set(bearer(token)).send(quote({ customerId: ravi, productId: await productId('Care Supreme') }));
    expect(noPrice.body.message).toBe('This product has no published price. Choose another product.');
    const tooMuch = await api().post(`${V1}/quotations/calculate`).set(bearer(token)).send(quote({ customerId: ravi, productId: optima, discountPercent: 30 }));
    expect(tooMuch.body.message).toBe('Discount must be between 0% and 25%.');

    await Customer.updateOne({ _id: ravi }, { $set: { dob: '1955-01-01' } });
    const old = await api().post(`${V1}/quotations/calculate`).set(bearer(token)).send(quote({ customerId: ravi, productId: await productId('Health Guard Gold') }));
    expect(old.status).toBe(400);
    expect(old.body.message).toMatch(/^Customer age \d+ is outside this product's eligibility \(Age 18–60\)\.$/);
    await Customer.updateOne({ _id: ravi }, { $set: { dob: '1986-04-12' } });
  });

  it('staff without the discount permission cannot give a discount', async () => {
    const res = await api().post(`${V1}/quotations/calculate`).set(bearer(await tokenOf(DEMO.staff.email)))
      .send(quote({ customerId: await customerId('Ravi Kumar'), productId: await productId('Family Health Optima'), discountPercent: 5 }));
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('You are not allowed to give discounts.');
  });
});

describe('Quotations', () => {
  it('needs consent; creates a numbered snapshot with a PDF link', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const noConsent = await api().post(`${V1}/quotations`).set(bearer(token))
      .send(quote({ customerId: await customerId('Sneha Rao'), productId: await productId('Family Health Optima') }));
    expect(noConsent.body.message).toBe("Record the customer's consent before creating a quotation.");

    const q = await newQuote(token);
    expect(q).toMatchObject({ status: 'GENERATED', approvalStatus: 'NONE' });
    expect(q.quoteNumber).toMatch(/^Q-\d{4}-\d{5}$/);
    const pdf = await api().get(pathOf(q.pdfUrl)).buffer(true);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await api().get(pathOf(q.pdfUrl).replace(/sig=[a-f0-9]+/, `sig=${'0'.repeat(64)}`))).status).toBe(403);
  });

  it('discount above 10 %: approved at once by the advisor, or waits as DRAFT until approved', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const noReason = await api().post(`${V1}/quotations`).set(bearer(token))
      .send(quote({ customerId: await customerId('Ravi Kumar'), productId: await productId('Family Health Optima'), discountPercent: 15 }));
    expect(noReason.body.message).toBe('Give a reason for the discount.');

    const now = await newQuote(token, { discountPercent: 15, discountReason: 'Loyal customer', approveDiscount: true });
    expect(now).toMatchObject({ status: 'GENERATED', approvalStatus: 'APPROVED' });

    const waiting = await newQuote(token, { discountPercent: 15, discountReason: 'Loyal customer' });
    expect(waiting).toMatchObject({ status: 'DRAFT', approvalStatus: 'PENDING' });
    const send = await api().post(`${V1}/quotations/${waiting.id}/send`).set(bearer(token)).send({});
    expect(send.body.message).toBe('The discount must be approved before sending.');
    const staff = await tokenOf(DEMO.staff.email);
    expect((await api().post(`${V1}/quotations/${waiting.id}/approve`).set(bearer(staff))).status).toBe(403);
    const approved = await api().post(`${V1}/quotations/${waiting.id}/approve`).set(bearer(token));
    expect(approved.body).toMatchObject({ status: 'GENERATED', approvalStatus: 'APPROVED' });
  });

  it('send → accept, in that order, and not after expiry', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const q = await newQuote(token);
    expect((await api().post(`${V1}/quotations/${q.id}/accept`).set(bearer(token))).body.message)
      .toBe('Send the quotation to the customer before recording acceptance.');
    expect((await api().post(`${V1}/quotations/${q.id}/send`).set(bearer(token)).send({ channel: 'WhatsApp' })).body.status).toBe('SENT');
    expect((await api().post(`${V1}/quotations/${q.id}/accept`).set(bearer(token))).body.status).toBe('ACCEPTED');

    const old = await newQuote(token);
    await api().post(`${V1}/quotations/${old.id}/send`).set(bearer(token)).send({});
    await Quotation.updateOne({ _id: old.id }, { $set: { validUntil: new Date(Date.now() - 1000) } });
    expect((await api().post(`${V1}/quotations/${old.id}/accept`).set(bearer(token))).body.message).toBe('This quotation has expired. Create a new one.');
  });

  it('gives unique running numbers even when created at the same moment', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const created = await Promise.all(Array.from({ length: 6 }, () => newQuote(token)));
    const numbers = created.map((q) => q.quoteNumber);
    expect(new Set(numbers).size).toBe(6);
  });

  it('a later product price change does not change existing quotations (snapshot)', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const before = await newQuote(token);
    const admin = await tokenOf(DEMO.admin.email);
    const optima = await productId('Family Health Optima');
    const edit = await api().patch(`${V1}/admin/products/${optima}`).set(bearer(admin)).send({ basePremium: 20000 });
    expect(edit.body).toMatchObject({ basePremium: 20000, version: 2 });

    const again = await api().get(`${V1}/quotations/${before.id}`).set(bearer(token));
    expect(again.body.pricing.total).toBe(before.pricing.total);
    const after = await newQuote(token);
    expect(after.pricing.total).toBe(20000);
    await api().patch(`${V1}/admin/products/${optima}`).set(bearer(admin)).send({ basePremium: 18450 });
  });

  it('lists quotations per customer; another advisor sees none', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const list = await api().get(`${V1}/quotations`).query({ customerId: await customerId('Ravi Kumar') }).set(bearer(token));
    expect(list.body.items.length).toBeGreaterThan(5);
    const { input } = await registerAdvisor({ approve: true });
    const other = await tokenOf(input.email, input.password);
    expect((await api().get(`${V1}/quotations`).set(bearer(other))).body.items).toHaveLength(0);
    expect((await api().get(`${V1}/quotations/${list.body.items[0].id}`).set(bearer(other))).status).toBe(404);
  });
});

describe('Product catalogue admin', () => {
  it('only platform admins can manage products; age range is checked', async () => {
    const advisor = await tokenOf(DEMO.advisor.email);
    expect((await api().get(`${V1}/admin/products`).set(bearer(advisor))).status).toBe(403);
    const admin = await tokenOf(DEMO.admin.email);
    const body = {
      name: 'Test Shield', companyName: 'Test Insurer', type: 'Life', basePremium: 9000, coverage: '₹50 lakh', features: [],
      addOns: [], exclusions: null, eligibility: 'Age 18–50', minAge: 18, maxAge: 50, source: 'Test brochure',
    };
    const bad = await api().post(`${V1}/admin/products`).set(bearer(admin)).send({ ...body, minAge: 60 });
    expect(bad.body.message).toBe('Minimum age cannot be above maximum age.');
    const created = await api().post(`${V1}/admin/products`).set(bearer(admin)).send(body);
    expect(created.status).toBe(201);
    await api().patch(`${V1}/admin/products/${created.body.id}`).set(bearer(admin)).send({ active: false });
    const visible = await api().get(`${V1}/products`).set(bearer(advisor));
    expect(visible.body.items.some((p: { name: string }) => p.name === 'Test Shield')).toBe(false);
    expect((await api().get(`${V1}/admin/products`).set(bearer(admin))).body.items.some((p: { name: string }) => p.name === 'Test Shield')).toBe(true);
  });
});
