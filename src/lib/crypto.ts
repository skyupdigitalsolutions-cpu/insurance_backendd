import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

// Long random token (refresh tokens). Only its hash is stored in the database.
export const randomToken = (bytes = 48): string => randomBytes(bytes).toString('base64url');

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export const hmacSha256 = (secret: string, value: string): string =>
  createHmac('sha256', secret).update(value).digest('hex');

// Compares two hex strings without leaking timing information
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export const randomDigits = (length: number): string =>
  Array.from({ length }, () => randomInt(0, 10)).join('');

// Temporary password for new staff accounts: letters + digits, easy to read aloud
export function temporaryPassword(): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const pick = (set: string, n: number) => Array.from({ length: n }, () => set[randomInt(0, set.length)]).join('');
  return `${pick(letters, 6)}${pick(digits, 4)}`;
}
