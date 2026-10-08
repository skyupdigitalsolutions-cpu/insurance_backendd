// Contract test for the Razorpay integration, against a local stand-in of the Razorpay API.
// It checks the request we send (amount in paise, reference, expiry, auth) and how we handle
// signed webhooks: valid, forged, repeated, wrong amount, expired.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as Helpers from './helpers.js';
import type { Payment as PaymentModel } from '../src/modules/payments/payment.model.js';
import type { Policy as PolicyModel } from '../src/modules/policies/policy.model.js';
import type { runReconcilePayments as ReconcileFn } from '../src/modules/jobs/maintenance.service.js';

const WEBHOOK_SECRET = 'test-webhook-secret-123';
type Seen = { auth: string | undefined; body: Record<string, unknown> };
const seen: Seen[] = [];
const linkStates = new Map<string, Record<string, unknown>>(); // what GET /v1/payment_links/:id returns
let fakeRazorpay: Server;

// Modules are loaded only after the environment is set (the config is read once at start-up)
let h: typeof Helpers;
let Payment: typeof PaymentModel;
let Policy: typeof PolicyModel;
let reconcile: typeof ReconcileFn;

beforeAll(async () => {
  fakeRazorpay = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      seen.push({ auth: req.headers.authorization, body });
      const get = /^\/v1\/payment_links\/([\w]+)$/.exec(req.url ?? '');
      if (req.method === 'GET' && get) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify(linkStates.get(get[1]!) ?? { id: get[1], status: 'created', amount_paid: 0, payments: null }));
        return;
      }
      if (req.url !== '/v1/payment_links' || req.method !== 'POST') { res.writeHead(404).end(); return; }
      const id = `plink_${seen.length}${Date.now()}`;
      res.writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ id, short_url: `https://rzp.io/i/${id}`, status: 'created', amount: body.amount, reference_id: body.reference_id }));
    });
  });
  await new Promise<void>((r) => fakeRazorpay.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    PAYMENT_PROVIDER: 'razorpay',
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'rzp_test_secret',
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RAZORPAY_API_BASE: `http://127.0.0.1:${(fakeRazorpay.address() as AddressInfo).port}`,
  });
  h = await import('./helpers.js');
  ({ Payment } = await import('../src/modules/payments/payment.model.js'));
  ({ Policy } = await import('../src/modules/policies/policy.model.js'));
  ({ runReconcilePayments: reconcile } = await import('../src/modules/jobs/maintenance.service.js'));
  await h.resetDatabase();
});

afterAll(async () => {
  await h.closeConnections();
  await new Promise<void>((r) => fakeRazorpay.close(() => r()));
});

async function paymentForNewQuote() {
  const token = await h.tokenOf(h.DEMO.advisor.email);
  const q = await h.api().post(`${h.V1}/quotations`).set(h.bearer(token)).send({
    customerId: await h.customerId('Ravi Kumar'), productId: await h.productId('Car Secure Comprehensive'),
    addOnIds: [], frequency: 'Yearly', discountPercent: 0, comparedProductIds: [],
  });
  await h.api().post(`${h.V1}/quotations/${q.body.id}/send`).set(h.bearer(token)).send({});
  await h.api().post(`${h.V1}/quotations/${q.body.id}/accept`).set(h.bearer(token));
  const p = await h.api().post(`${h.V1}/quotations/${q.body.id}/payment-link`).set(h.bearer(token)).send({ method: 'Payment link' });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const doc = await Payment.findById(p.body.id).lean();
  return { token, quote: q.body as { id: string }, payment: p.body as { id: string; amount: number; link: string }, linkId: doc!.providerLinkId! };
}

const webhook = (body: unknown, opts: { secret?: string; eventId?: string } = {}) => {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', opts.secret ?? WEBHOOK_SECRET).update(raw).digest('hex');
  return h.api().post(`${h.V1}/webhooks/razorpay`).set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', sig).set('X-Razorpay-Event-Id', opts.eventId ?? `evt_${Math.random().toString(36).slice(2)}`).send(raw);
};
const paidEvent = (linkId: string, amountPaise: number) => ({
  entity: 'event', event: 'payment_link.paid', contains: ['payment_link', 'payment'],
  payload: {
    payment_link: { entity: { id: linkId, status: 'paid', amount: amountPaise, amount_paid: amountPaise } },
    payment: { entity: { id: 'pay_RZP123456', amount: amountPaise, status: 'captured', method: 'upi' } },
  },
});

describe('Creating a Razorpay payment link', () => {
  it('sends amount in paise, our reference, expiry and Basic auth; returns Razorpay’s short URL', async () => {
    const { payment } = await paymentForNewQuote();
    const call = seen.at(-1)!;
    expect(call.auth).toBe(`Basic ${Buffer.from('rzp_test_key:rzp_test_secret').toString('base64')}`);
    expect(call.body).toMatchObject({ amount: payment.amount * 100, currency: 'INR', accept_partial: false, reference_id: payment.id });
    expect((call.body.customer as { contact: string }).contact).toBe('+919876543210');
    expect(call.body.expire_by as number).toBeGreaterThan(Date.now() / 1000 + 60 * 60);
    expect(payment.link).toMatch(/^https:\/\/rzp\.io\/i\/plink_/);
  });
});

describe('Razorpay webhook', () => {
  it('refuses a body with a wrong signature', async () => {
    const { linkId, payment } = await paymentForNewQuote();
    const res = await webhook(paidEvent(linkId, payment.amount * 100), { secret: 'not-the-secret' });
    expect(res.status).toBe(400);
    expect((await Payment.findById(payment.id).lean())!.status).toBe('PENDING');
  });

  it('payment_link.paid marks the payment paid and creates one policy, even if sent twice', async () => {
    const { linkId, payment, quote } = await paymentForNewQuote();
    const first = await webhook(paidEvent(linkId, payment.amount * 100), { eventId: 'evt_same_1' });
    expect(first.body).toEqual({ status: 'applied' });
    const repeat = await webhook(paidEvent(linkId, payment.amount * 100), { eventId: 'evt_same_1' });
    expect(repeat.body).toEqual({ status: 'duplicate' });
    const p = await Payment.findById(payment.id).lean();
    expect(p).toMatchObject({ status: 'SUCCESS', transactionRef: 'pay_RZP123456' });
    expect(await Policy.countDocuments({ quotationId: quote.id })).toBe(1);
  });

  it('ignores a "paid" event with a different amount', async () => {
    const { linkId, payment } = await paymentForNewQuote();
    const res = await webhook(paidEvent(linkId, 100));
    expect(res.body).toEqual({ status: 'ignored' });
    expect((await Payment.findById(payment.id).lean())!.status).toBe('PENDING');
  });

  it('payment_link.expired marks the payment failed', async () => {
    const { linkId, payment } = await paymentForNewQuote();
    const res = await webhook({ entity: 'event', event: 'payment_link.expired', payload: { payment_link: { entity: { id: linkId, status: 'expired' } } } });
    expect(res.body).toEqual({ status: 'applied' });
    expect(await Payment.findById(payment.id).lean()).toMatchObject({ status: 'FAILED', failureReason: 'Payment link expired' });
  });

  it('the practice checkout page does not exist in Razorpay mode', async () => {
    expect((await h.api().get('/pay/anything')).status).toBe(404);
  });
});

describe('Payment reconciliation job (a webhook that never arrived)', () => {
  it('asks Razorpay about older open links and applies "paid" exactly once', async () => {
    const paid = await paymentForNewQuote();
    const open = await paymentForNewQuote();
    const tooOld = new Date(Date.now() - 15 * 60_000);
    await Payment.updateMany({ _id: { $in: [paid.payment.id, open.payment.id] } }, { $set: { updatedAt: tooOld } }, { timestamps: false });
    linkStates.set(paid.linkId, {
      id: paid.linkId, status: 'paid', amount_paid: paid.payment.amount * 100, payments: [{ payment_id: 'pay_RECON1', status: 'captured' }],
    });

    const result = await reconcile();
    expect(result).toMatchObject({ paid: 1, closed: 0, errors: 0 });
    expect(result.checked).toBeGreaterThanOrEqual(2);
    expect(await Payment.findById(paid.payment.id).lean()).toMatchObject({ status: 'SUCCESS', transactionRef: 'pay_RECON1' });
    expect(await Policy.countDocuments({ quotationId: paid.quote.id })).toBe(1);
    expect((await Payment.findById(open.payment.id).lean())!.status).toBe('PENDING');

    // The late webhook for the same payment changes nothing
    expect((await webhook(paidEvent(paid.linkId, paid.payment.amount * 100))).body).toEqual({ status: 'ignored' });
    expect(await Policy.countDocuments({ quotationId: paid.quote.id })).toBe(1);
  });
});
