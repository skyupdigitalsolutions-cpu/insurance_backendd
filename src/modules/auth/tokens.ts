import jwt from 'jsonwebtoken';
import type { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { unauthorized } from '../../lib/errors.js';

const ISSUER = 'insurance-api';
const AUDIENCE = 'insurance-app';

export type AccessTokenPayload = { sub: string; sid: string };

// Short-lived access token (15 min by default). sid = the device session it belongs to,
// so logging out (revoking the session) also stops the access token immediately.
export function signAccessToken(userId: Types.ObjectId, sessionId: Types.ObjectId): string {
  return jwt.sign({ sid: sessionId.toString() }, env.JWT_ACCESS_SECRET, {
    subject: userId.toString(),
    expiresIn: env.ACCESS_TOKEN_TTL_SEC,
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
      throw new Error('Malformed token');
    }
    return { sub: payload.sub, sid: payload.sid };
  } catch {
    throw unauthorized();
  }
}
