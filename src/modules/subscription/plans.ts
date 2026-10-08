// The advisor's own subscription to this app (not the customer's insurance).
// Software subscriptions carry 18 % GST.
export const FEATURES = ['crm', 'quotes', 'renewals', 'reports', 'ai', 'autodial', 'whatsapp', 'team'] as const;
export type FeatureKey = (typeof FEATURES)[number];
export type PlanId = 'trial' | 'basic' | 'pro';
export type BillingCycle = 'monthly' | 'yearly';

export const TRIAL_DAYS = 14;
export const SUBSCRIPTION_GST_RATE = 0.18;
export const GRACE_DAYS = 3; // a paid plan keeps working 3 days after its end date while payment is sorted out

export type Plan = {
  id: PlanId; name: string; tagline: string; monthly: number; yearly: number; users: number; features: FeatureKey[]; popular?: boolean;
};

export const PLANS: Plan[] = [
  { id: 'trial', name: 'Free Trial', tagline: `${TRIAL_DAYS} days with every feature`, monthly: 0, yearly: 0, users: 5, features: [...FEATURES] },
  { id: 'basic', name: 'Basic', tagline: 'For individual advisors', monthly: 499, yearly: 4990, users: 1, features: ['crm', 'quotes', 'renewals', 'reports'] },
  { id: 'pro', name: 'Pro', tagline: 'AI, Autodial and team access', monthly: 999, yearly: 9990, users: 5, features: [...FEATURES], popular: true },
];

export const planById = (id: string): Plan | undefined => PLANS.find((p) => p.id === id);

export const FEATURE_NAMES: Record<FeatureKey, string> = {
  crm: 'CRM', quotes: 'Quotations', renewals: 'Renewals', reports: 'Reports', ai: 'AI recommendations',
  autodial: 'Autodial', whatsapp: 'WhatsApp automation', team: 'Team access',
};
