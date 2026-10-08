// Shared input rules, written once and used by every module.
import { z } from 'zod';

// Indian mobile numbers. Accepts 9876543210, +919876543210 or "+91 98765 43210"; always stored as +919876543210.
export const indianMobile = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^(\+91)?[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit Indian mobile number')
  .transform((v) => (v.startsWith('+91') ? v : `+91${v}`));

export const email = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')).pipe(z.string().max(254));

export const personName = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(80, 'Name must be at most 80 characters');

// Same rule as the app's Register screen
export const newPassword = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(128, 'Password must be at most 128 characters.')
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Password must contain a letter and a number.');

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
export const idParams = z.object({ id: objectId });

export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// "+919876543210" → "+91 98•••••210" (same format the app shows)
export const maskMobile = (mobile: string): string =>
  `${mobile.slice(0, 3)} ${mobile.slice(3, 5)}•••••${mobile.slice(-3)}`;

// "1990-05-31": a real calendar date, not in the future (dates of birth)
export const pastDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, 'Enter a real date')
  .refine((v) => new Date(`${v}T00:00:00Z`).getTime() <= Date.now(), 'Date cannot be in the future');

export const pinCode = z.string().trim().regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code');

// Optional free text: trims, turns "" into undefined, limits length
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Must be at most ${max} characters`)
    .optional()
    .transform((v) => (v ? v : undefined));

export const optionalEmail = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v.toLowerCase() : undefined))
  .pipe(z.email('Enter a valid email address').max(254).optional());

// Search box text → safe case-insensitive pattern (user input is never used as a raw regex)
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const listQuery = z.object({
  q: z.string().trim().max(100).optional().default(''),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
