// Payment providers. The rest of the code only uses `paymentProvider.createLink(...)`.
//   mock     → a practice checkout page on this server (no real money; development/staging)
//   razorpay → Razorpay Payment Links (the customer pays by UPI, card or net banking on Razorpay's page)
import { env } from '../../config/env.js';
import { randomToken } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export type CreateLinkInput = {
  referenceId: string; // our payment id (unique)
  amountRupees: number;
  description: string;
  customer: { name: string; mobile: string; email?: string | null };
  expiresAt: Date;
};
export type CreatedLink = { linkId: string; url: string };
// Current state of a link at the provider (used by the reconciliation job if a webhook was missed)
export type LinkState = { status: 'open' | 'paid' | 'expired' | 'cancelled'; amountPaidPaise: number; transactionRef?: string };

export interface PaymentProvider {
  readonly name: 'mock' | 'razorpay';
  createLink(input: CreateLinkInput): Promise<CreatedLink>;
  fetchLink(linkId: string): Promise<LinkState | null>; // null = this provider has nothing to reconcile
}

class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;
  createLink(): Promise<CreatedLink> {
    const linkId = `mock_${randomToken(12)}`;
    return Promise.resolve({ linkId, url: `${env.PUBLIC_BASE_URL}/pay/${linkId}` });
  }
  fetchLink(): Promise<LinkState | null> {
    return Promise.resolve(null); // the practice page reports results directly; nothing can be missed
  }
}

class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;

  async createLink(input: CreateLinkInput): Promise<CreatedLink> {
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(`${env.RAZORPAY_API_BASE}/v1/payment_links`, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: Math.round(input.amountRupees * 100), // Razorpay works in paise
          currency: 'INR',
          accept_partial: false,
          reference_id: input.referenceId,
          description: input.description.slice(0, 2048),
          customer: { name: input.customer.name, contact: input.customer.mobile, ...(input.customer.email ? { email: input.customer.email } : {}) },
          notify: { sms: false, email: false }, // the advisor shares the link (WhatsApp) from the app
          reminder_enable: false,
          expire_by: Math.floor(input.expiresAt.getTime() / 1000),
          notes: { reference_id: input.referenceId },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      logger.error({ err }, 'Razorpay not reachable');
      throw new AppError(502, 'PAYMENT_PROVIDER_DOWN', 'Payment provider is not reachable. Try again in a minute.');
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string; short_url?: string; error?: { description?: string } };
    if (!res.ok || !body.id || !body.short_url) {
      logger.error({ status: res.status, error: body.error }, 'Razorpay refused the payment link');
      throw new AppError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider could not create the link. Try again.');
    }
    return { linkId: body.id, url: body.short_url };
  }

  async fetchLink(linkId: string): Promise<LinkState | null> {
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const res = await fetch(`${env.RAZORPAY_API_BASE}/v1/payment_links/${encodeURIComponent(linkId)}`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Razorpay returned ${res.status} for ${linkId}`);
    const body = (await res.json()) as { status?: string; amount_paid?: number; payments?: { payment_id?: string; status?: string }[] | null };
    const status = body.status === 'paid' ? 'paid' : body.status === 'expired' ? 'expired' : body.status === 'cancelled' ? 'cancelled' : 'open';
    const captured = body.payments?.find((p) => p.status === 'captured') ?? body.payments?.[0];
    return { status, amountPaidPaise: body.amount_paid ?? 0, ...(captured?.payment_id ? { transactionRef: captured.payment_id } : {}) };
  }
}

export const paymentProvider: PaymentProvider = env.PAYMENT_PROVIDER === 'razorpay' ? new RazorpayProvider() : new MockProvider();
