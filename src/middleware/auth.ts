import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { forbidden, unauthorized } from '../lib/errors.js';
import { Session } from '../modules/auth/session.model.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import type { Permission } from '../modules/roles/permissions.js';
import { Role } from '../modules/roles/role.model.js';
import { User } from '../modules/users/user.model.js';

// Who is calling, filled in by `authenticate` on every protected request
export type AuthContext = {
  userId: Types.ObjectId;
  orgId: Types.ObjectId | null;
  sessionId: Types.ObjectId;
  roleId: Types.ObjectId;
  roleName: string;
  name: string;
  email: string;
  mobile: string;
  permissions: string[];
  isPlatformAdmin: boolean;
  mustChangePassword: boolean;
};

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
    rawBody?: Buffer; // set by express.json (for webhook signatures)
  }
}

// Checks the Bearer token, the device session, the user and the role on every request.
// Permissions are read fresh each time, so role changes and deactivation apply immediately.
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  const { sub, sid } = verifyAccessToken(header.slice('Bearer '.length).trim());
  if (!Types.ObjectId.isValid(sub) || !Types.ObjectId.isValid(sid)) throw unauthorized();

  const [user, session] = await Promise.all([User.findById(sub).lean(), Session.findById(sid).lean()]);
  if (!user || user.status !== 'ACTIVE') throw unauthorized();
  if (!session || session.revokedAt || session.expiresAt <= new Date() || !session.userId.equals(user._id)) {
    throw unauthorized();
  }
  const role = await Role.findById(user.roleId).lean();
  if (!role) throw unauthorized();

  req.auth = {
    userId: user._id,
    orgId: user.orgId ?? null,
    sessionId: session._id,
    roleId: role._id,
    roleName: role.name,
    name: user.name,
    email: user.email,
    mobile: user.mobile,
    permissions: role.permissions,
    isPlatformAdmin: user.isPlatformAdmin,
    mustChangePassword: user.mustChangePassword,
  };
  next();
}

// The server checks permission on every request, even if the app already hid the button
export function requirePermission(code: Permission) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const auth = req.auth;
    if (!auth) throw unauthorized();
    const isPlatformCode = code.startsWith('platform:');
    if (isPlatformCode ? !auth.isPlatformAdmin : !auth.orgId) throw forbidden();
    if (!auth.permissions.includes(code)) throw forbidden();
    next();
  };
}

// For organization-scoped handlers: returns the caller's orgId (always present after requirePermission)
export function orgIdOf(auth: AuthContext): Types.ObjectId {
  if (!auth.orgId) throw forbidden();
  return auth.orgId;
}
