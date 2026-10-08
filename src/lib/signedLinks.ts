// Short-lived links that work without a login header (open a PDF in the phone's browser, share it).
// The signature covers the kind, the id and the expiry, so a link cannot be changed to open something else.
import { env } from '../config/env.js';
import { hmacSha256, safeEqualHex } from './crypto.js';
import { forbidden } from './errors.js';

const sign = (kind: string, id: string, expires: number) => hmacSha256(env.FILE_URL_SECRET, `${kind}:${id}:${expires}`);

export function signedLink(baseUrl: string, path: string, kind: string, id: string, ttlSec = env.FILE_URL_TTL_SEC): string {
  const expires = Math.floor(Date.now() / 1000) + ttlSec;
  return `${baseUrl}${path}?expires=${expires}&sig=${sign(kind, id, expires)}`;
}

export function verifySignedLink(kind: string, id: string, expires: number, sig: string): void {
  if (expires < Math.floor(Date.now() / 1000)) throw forbidden('This link has expired. Open it again from the app.', 'LINK_EXPIRED');
  if (!/^[a-f\d]{64}$/.test(sig) || !safeEqualHex(sig, sign(kind, id, expires))) throw forbidden('Invalid link.', 'LINK_INVALID');
}
