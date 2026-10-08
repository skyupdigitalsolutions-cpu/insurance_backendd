import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { maskMobile } from '../../lib/validators.js';

// Every SMS the platform sends. In India each one must match a template registered on the DLT portal
// (TRAI rule), so the wording lives here in one place and is registered word for word.
// {#var#} in the DLT template = the value in `vars`.
export const SMS_TEMPLATES = {
  otp: (v: { code: string }) => `${v.code} is your Insurance Advisor verification code. It is valid for 5 minutes. Do not share it with anyone.`,
  account_approved: () => 'Your Insurance Advisor account is approved. You can log in now.',
  staff_invite: (v: { by: string; email: string; password: string }) =>
    `${v.by} added you to Insurance Advisor. Log in with ${v.email} and temporary password ${v.password}. You will be asked to change it.`,
  plan_renewal: (v: { plan: string; date: string; link: string }) =>
    `Your Insurance Advisor ${v.plan} plan renews on ${v.date}. Pay securely here to continue without a break: ${v.link}`,
  trial_ending: (v: { date: string }) =>
    `Your Insurance Advisor free trial ends on ${v.date}. Open the app and go to Subscription to choose a plan.`,
} as const;

export type SmsKind = keyof typeof SMS_TEMPLATES;
export type SmsVars<K extends SmsKind> = Parameters<(typeof SMS_TEMPLATES)[K]>[0] extends undefined
  ? Record<string, never>
  : Parameters<(typeof SMS_TEMPLATES)[K]>[0];

export const smsText = <K extends SmsKind>(kind: K, vars: SmsVars<K>): string =>
  (SMS_TEMPLATES[kind] as (v: SmsVars<K>) => string)(vars);

export interface SmsProvider {
  send<K extends SmsKind>(to: string, kind: K, vars: SmsVars<K>): Promise<void>;
}

// Development/staging: prints the SMS to the server log instead of sending it
class ConsoleSmsProvider implements SmsProvider {
  send<K extends SmsKind>(to: string, kind: K, vars: SmsVars<K>): Promise<void> {
    logger.info({ to: maskMobile(to), kind, sms: smsText(kind, vars) }, 'SMS (console provider, not really sent)');
    return Promise.resolve();
  }
}

// "otp=65f0…,account_approved=65f1…" → { otp: '65f0…', … }; every kind must have a template id
export function parseTemplateIds(raw: string): Record<SmsKind, string> {
  const map = Object.fromEntries(
    raw.split(',').map((pair) => pair.split('=').map((s) => s.trim())).filter((p) => p.length === 2 && p[0] && p[1]),
  ) as Record<string, string>;
  const missing = (Object.keys(SMS_TEMPLATES) as SmsKind[]).filter((k) => !map[k]);
  if (missing.length) throw new Error(`MSG91_TEMPLATE_IDS is missing: ${missing.join(', ')}`);
  return map;
}

// MSG91 Flow API: sends a MSG91 template linked to its DLT template; MSG91 fills ##var## with the values we pass
class Msg91SmsProvider implements SmsProvider {
  private readonly templateIds = parseTemplateIds(env.MSG91_TEMPLATE_IDS);

  async send<K extends SmsKind>(to: string, kind: K, vars: SmsVars<K>): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${env.MSG91_API_BASE}/api/v5/flow`, {
        method: 'POST',
        headers: { authkey: env.MSG91_AUTH_KEY ?? '', 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          template_id: this.templateIds[kind],
          short_url: '0',
          recipients: [{ mobiles: to.replace(/^\+/, ''), ...vars }], // 91XXXXXXXXXX
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      logger.error({ err, kind }, 'MSG91 not reachable');
      throw new AppError(502, 'SMS_PROVIDER_DOWN', 'Could not send the SMS. Try again in a minute.');
    }
    const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
    if (!res.ok || body.type !== 'success') {
      logger.error({ status: res.status, body, kind, to: maskMobile(to) }, 'MSG91 refused the SMS');
      throw new AppError(502, 'SMS_PROVIDER_ERROR', 'Could not send the SMS. Try again in a minute.');
    }
    logger.info({ kind, to: maskMobile(to), requestId: body.message }, 'SMS sent');
  }
}

export const sms: SmsProvider = env.SMS_PROVIDER === 'msg91' ? new Msg91SmsProvider() : new ConsoleSmsProvider();
