// PRACTICE CHECKOUT (PAYMENT_PROVIDER=mock only, never in production).
// Stands in for the Razorpay payment page so the whole flow can be tested without real money:
// the customer opens the link, taps Pay or Fail, and the server applies the result through the
// same code path a real Razorpay webhook uses.
import express, { Router } from 'express';
import { randomToken } from '../../lib/crypto.js';
import { Payment, type PaymentDoc } from './payment.model.js';
import { SubscriptionCheckout, type CheckoutDoc } from '../subscription/subscription.model.js';
import { applyProviderResult } from './payments.service.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#F4F7FC;color:#1A2433}
.top{background:#3A75C4;color:#fff;padding:20px 16px}.top b{font-size:18px}.tag{font-size:12px;opacity:.85}
.card{background:#fff;margin:16px;border-radius:14px;padding:18px;box-shadow:0 4px 16px rgba(26,36,51,.08)}
.amount{font-size:32px;font-weight:800;color:#24528F;margin:6px 0 2px}.muted{color:#5B6B80;font-size:14px}
button{width:100%;padding:15px;border:0;border-radius:10px;font-size:16px;font-weight:700;margin-top:12px;cursor:pointer}
.pay{background:#3A75C4;color:#fff}.fail{background:#FDECEC;color:#C62828}
.note{margin:16px;font-size:12px;color:#8A98AA;text-align:center}.ok{color:#2E7D32}.bad{color:#C62828}
</style></head><body><div class="top"><b>Practice checkout</b><div class="tag">No real money · development only</div></div>${body}</body></html>`;

// What the customer (or advisor) is paying for: a premium payment or a plan checkout
async function findByLink(linkId: string): Promise<{ amount: number; title: string; reference: string; paid: boolean } | null> {
  const p = await Payment.findOne({ providerLinkId: linkId }).lean<PaymentDoc>();
  if (p) return { amount: p.amount, title: p.customerName, reference: `Quotation ${p.quoteNumber}`, paid: p.status === 'SUCCESS' };
  const c = await SubscriptionCheckout.findOne({ providerLinkId: linkId }).lean<CheckoutDoc>();
  if (c) return { amount: c.total, title: `Insurance Advisor ${c.planId === 'pro' ? 'Pro' : 'Basic'} plan`, reference: `${c.cycle} · incl. 18% GST`, paid: c.status === 'PAID' };
  return null;
}

export const checkoutRouter = Router();
checkoutRouter.use(express.urlencoded({ extended: false, limit: '2kb' }));

checkoutRouter.get('/pay/:linkId', async (req, res) => {
  const t = await findByLink(req.params.linkId);
  if (!t) { res.status(404).send(page('Not found', '<div class="card">This payment link does not exist.</div>')); return; }
  res.send(page(`Pay ${inr(t.amount)}`, `<div class="card"><div class="muted">${esc(t.title)} · ${esc(t.reference)}</div>
<div class="amount">${inr(t.amount)}</div>
${t.paid ? '<p class="ok"><b>Already paid.</b> Thank you!</p>' : `<form method="post"><input type="hidden" name="result" value="success"><button class="pay">Pay ${inr(t.amount)}</button></form>
<form method="post"><input type="hidden" name="result" value="fail"><button class="fail">Simulate a failed payment</button></form>`}
</div><div class="note">In production this page is Razorpay's secure checkout (UPI, cards, net banking).</div>`));
});

checkoutRouter.post('/pay/:linkId', async (req, res) => {
  const t = await findByLink(req.params.linkId);
  if (!t) { res.status(404).send(page('Not found', '<div class="card">This payment link does not exist.</div>')); return; }
  const success = (req.body as { result?: string }).result === 'success';
  await applyProviderResult({
    eventId: `mock_${randomToken(9)}`,
    event: success ? 'payment_link.paid' : 'payment.failed',
    providerLinkId: req.params.linkId,
    outcome: success ? 'PAID' : 'FAILED',
    amountPaise: Math.round(t.amount * 100),
    transactionRef: success ? `pay_MOCK${randomToken(6)}` : undefined,
    reason: success ? undefined : 'Payment declined (practice)',
  });
  res.send(page(success ? 'Payment successful' : 'Payment failed', `<div class="card">
${success ? `<h2 class="ok">Payment successful</h2><p>${inr(t.amount)} received (${esc(t.reference)}).</p>`
    : '<h2 class="bad">Payment failed</h2><p>No money was taken. You can try again from the app.</p>'}
<p class="muted">You can close this page.</p></div>`));
});
