// Reads and checks every environment variable once, at startup.
// If something required is missing or wrong, the server refuses to start with a clear message.
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

// An empty value in .env ("S3_ENDPOINT=") means "not set"
const optionalUrl = z.preprocess((v) => (v === '' ? undefined : v), z.url().optional());

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0), // 1 when running behind Railway/Render/Nginx

    MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().min(60).default(900), // 15 minutes
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),
    OTP_SECRET: z.string().min(32, 'OTP_SECRET must be at least 32 characters'),

    // Comma-separated list of web origins allowed to call the API (the mobile app does not need this)
    CORS_ORIGINS: z.string().default(''),

    // SMS (OTP, account messages). "console" prints to the log; "msg91" sends real SMS (DLT-registered templates)
    SMS_PROVIDER: z.enum(['console', 'msg91']).default('console'),
    MSG91_AUTH_KEY: z.string().optional(),
    // MSG91 template id of each SMS kind (each one linked to its DLT template), e.g. "otp=65f0…,account_approved=65f1…"
    MSG91_TEMPLATE_IDS: z.string().default(''),
    MSG91_API_BASE: z.url().default('https://control.msg91.com'),
    // Development/staging only: every OTP becomes this code, so testers do not need a real SMS
    OTP_FIXED_CODE: z
      .string()
      .regex(/^\d{6}$/, 'OTP_FIXED_CODE must be 6 digits')
      .optional()
      .or(z.literal('').transform(() => undefined)),

    // Customer messages. "console" prints to the log; "meta" = WhatsApp Cloud API; "smtp" = real email
    WHATSAPP_PROVIDER: z.enum(['console', 'meta']).default('console'),
    WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    WHATSAPP_APP_SECRET: z.string().optional(),   // checks the signature of delivery-status webhooks
    WHATSAPP_VERIFY_TOKEN: z.string().optional(), // any secret text; typed once in the Meta webhook settings
    WHATSAPP_API_BASE: z.url().default('https://graph.facebook.com/v21.0'),
    EMAIL_PROVIDER: z.enum(['console', 'smtp']).default('console'),
    SMTP_URL: z.string().optional(), // smtps://user:password@smtp.example.com:465
    EMAIL_FROM: z.string().default('Insurance Advisor <no-reply@example.com>'),

    // Uploaded customer documents. "local" = a folder on this server (development/staging);
    // "s3" = a private bucket on AWS S3, Cloudflare R2 or any S3-compatible storage (production).
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default('ap-south-1'), // Mumbai; use "auto" for Cloudflare R2
    S3_ENDPOINT: optionalUrl,                      // only for R2 / other S3-compatible storage
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    UPLOADS_DIR: z.string().default('./uploads'),
    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(25).default(10),
    FILE_URL_SECRET: z.string().min(32, 'FILE_URL_SECRET must be at least 32 characters'),
    FILE_URL_TTL_SEC: z.coerce.number().int().min(60).max(86_400).default(900), // document links work for 15 minutes

    // Address customers and payment providers use to reach this server (no trailing slash)
    PUBLIC_BASE_URL: z.url().default('http://localhost:4000').transform((v) => v.replace(/\/+$/, '')),

    // Payments. "mock" = a built-in practice checkout page (development/staging); "razorpay" = real money.
    PAYMENT_PROVIDER: z.enum(['mock', 'razorpay']).default('mock'),
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    RAZORPAY_API_BASE: z.url().default('https://api.razorpay.com'),
    PAYMENT_LINK_EXPIRY_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(72),
    QUOTE_VALIDITY_DAYS: z.coerce.number().int().min(1).max(90).default(30),

    // Background jobs (the worker process)
    RENEWAL_REMINDER_DAYS: z
      .string()
      .default('30,7,1')
      .transform((v) => [...new Set(v.split(',').map((d) => Number(d.trim())))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 90)),
    PAYMENT_REMINDER_AFTER_HOURS: z.coerce.number().int().min(1).max(24 * 7).default(24),
    PLAN_REMINDER_DAYS: z.coerce.number().int().min(1).max(15).default(3),

    RATE_LIMIT_ENABLED: bool.default(true),
    API_DOCS_ENABLED: bool.default(true),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.OTP_FIXED_CODE) {
      ctx.addIssue({ code: 'custom', path: ['OTP_FIXED_CODE'], message: 'OTP_FIXED_CODE must not be set in production' });
    }
    if (env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'console') {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_PROVIDER'],
        message: 'A real SMS provider is required in production (use NODE_ENV=staging until it is added)',
      });
    }
    const need = (when: boolean, keys: readonly (keyof typeof env)[], what: string) => {
      if (!when) return;
      for (const key of keys) if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when ${what}` });
    };
    need(env.SMS_PROVIDER === 'msg91', ['MSG91_AUTH_KEY', 'MSG91_TEMPLATE_IDS'], 'SMS_PROVIDER=msg91');
    need(env.WHATSAPP_PROVIDER === 'meta', ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN'], 'WHATSAPP_PROVIDER=meta');
    need(env.EMAIL_PROVIDER === 'smtp', ['SMTP_URL'], 'EMAIL_PROVIDER=smtp');
    need(env.STORAGE_DRIVER === 's3', ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'], 'STORAGE_DRIVER=s3');
    if (env.PAYMENT_PROVIDER === 'razorpay') {
      for (const key of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] as const) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: `${key} is required when PAYMENT_PROVIDER=razorpay` });
      }
    }
    for (const [key, value] of [['WHATSAPP_PROVIDER', env.WHATSAPP_PROVIDER], ['EMAIL_PROVIDER', env.EMAIL_PROVIDER]] as const) {
      if (env.NODE_ENV === 'production' && value === 'console') {
        ctx.addIssue({ code: 'custom', path: [key], message: `A real ${key === 'EMAIL_PROVIDER' ? 'email' : 'WhatsApp'} provider is required in production (use NODE_ENV=staging until it is added)` });
      }
    }
    if (env.NODE_ENV === 'production' && env.PAYMENT_PROVIDER === 'mock') {
      ctx.addIssue({ code: 'custom', path: ['PAYMENT_PROVIDER'], message: 'The practice checkout cannot be used in production (set PAYMENT_PROVIDER=razorpay)' });
    }
    if (env.NODE_ENV === 'production' && env.STORAGE_DRIVER === 'local') {
      ctx.addIssue({
        code: 'custom',
        path: ['STORAGE_DRIVER'],
        message: 'Private cloud storage (S3-compatible) is required in production (use NODE_ENV=staging until it is added)',
      });
    }
  });

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // The logger depends on this config, so plain console is used here on purpose
  console.error(`Invalid environment configuration:\n${lines}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
export const corsOrigins = env.CORS_ORIGINS.split(',')
  .map((o) => o.trim())
  .filter(Boolean);
