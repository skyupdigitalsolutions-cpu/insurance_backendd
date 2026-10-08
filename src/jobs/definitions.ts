// Every scheduled job in one list: what it does, when it runs (Indian time) and the function it calls.
// The worker registers these schedules in Redis at start-up; the admin panel shows them and can run one now.
import { runExpirePaymentLinks, runExpireQuotes, runReconcilePayments } from '../modules/jobs/maintenance.service.js';
import { runBirthdayWishes, runPaymentReminders, runRenewalReminders } from '../modules/jobs/reminders.service.js';
import { runPlanReminders } from '../modules/subscription/subscription.service.js';

export const JOB_TIMEZONE = 'Asia/Kolkata';

type JobDef = { label: string; description: string; cron: string; schedule: string; run: () => Promise<unknown> };

export const JOBS = {
  'renewal-reminders': {
    label: 'Renewal reminders', cron: '0 9 * * *', schedule: 'Daily 9:00 AM',
    description: 'Policies due in 30 / 7 / 1 days: WhatsApp reminder (Pro, with consent) or a call task for the advisor',
    run: () => runRenewalReminders(),
  },
  'birthday-wishes': {
    label: 'Birthday wishes', cron: '5 9 * * *', schedule: 'Daily 9:05 AM',
    description: 'Customers with a birthday today: WhatsApp wishes (Pro, with consent) or a task for the advisor',
    run: () => runBirthdayWishes(),
  },
  'payment-reminders': {
    label: 'Payment reminders', cron: '15 * * * *', schedule: 'Every hour at :15',
    description: 'Payment links still unpaid after 24 hours: one reminder per link',
    run: () => runPaymentReminders(),
  },
  'plan-reminders': {
    label: 'Plan renewal reminders', cron: '0 10 * * *', schedule: 'Daily 10:00 AM',
    description: 'Advisors whose plan renews in 3 days get a payment link by SMS; trials ending soon get a reminder',
    run: () => runPlanReminders(),
  },
  'expire-quotes': {
    label: 'Expire old quotations', cron: '30 0 * * *', schedule: 'Daily 12:30 AM',
    description: 'Quotations past their validity that were never accepted are closed as Expired',
    run: () => runExpireQuotes(),
  },
  'expire-payment-links': {
    label: 'Expire payment links', cron: '*/15 * * * *', schedule: 'Every 15 minutes',
    description: 'Payment and plan links past their expiry are marked failed',
    run: () => runExpirePaymentLinks(),
  },
  'reconcile-payments': {
    label: 'Payment reconciliation', cron: '*/30 * * * *', schedule: 'Every 30 minutes',
    description: 'Asks Razorpay about open links in case a webhook was missed (does nothing with practice payments)',
    run: () => runReconcilePayments(),
  },
} satisfies Record<string, JobDef>;

export type JobName = keyof typeof JOBS;
export const JOB_NAMES = Object.keys(JOBS) as JobName[];
export const isJobName = (name: string): name is JobName => name in JOBS;
