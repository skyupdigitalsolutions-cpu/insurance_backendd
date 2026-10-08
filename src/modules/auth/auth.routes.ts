import type { Request } from 'express';
import { z } from 'zod';
import { requestIdOf } from '../../lib/errors.js';
import { defineRoute } from '../../lib/route.js';
import { email, indianMobile, newPassword, objectId, personName } from '../../lib/validators.js';
import { changePassword, forgotPassword, login, logout, refresh, toMe, type ClientInfo } from './auth.service.js';
import { register, registrationStatus, resendOtp, verifyOtp } from './registration.service.js';

const clientOf = (req: Request): ClientInfo => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
  requestId: requestIdOf(req),
});

const loginInput = z.object({
  identifier: z.string().trim().min(1, 'Email or mobile is required').max(254),
  password: z.string().min(1, 'Password is required').max(128),
});
const refreshInput = z.object({ refreshToken: z.string().min(20).max(200) });
const registerInput = z.object({
  name: personName,
  email,
  mobile: indianMobile,
  password: newPassword,
  irdaiNumber: z
    .string()
    .trim()
    .max(30, 'IRDAI number must be at most 30 characters')
    .optional()
    .transform((v) => (v ? v : undefined)),
});
const resendInput = z.object({ challengeId: z.string().min(1).max(64) });
const verifyInput = z.object({
  challengeId: z.string().min(1).max(64),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});
const changePasswordInput = z.object({ currentPassword: z.string().min(1).max(128), newPassword });

export const authRoutes = [
  defineRoute({
    method: 'post', path: '/auth/login', tag: 'Auth', summary: 'Log in with email or mobile + password',
    access: 'public', limiter: 'login', body: loginInput,
    handler: ({ body, req }) => login(body.identifier, body.password, clientOf(req)),
  }),
  defineRoute({
    method: 'post', path: '/auth/refresh', tag: 'Auth', summary: 'Get a new access token (refresh token rotates)',
    access: 'public', limiter: 'refresh', body: refreshInput,
    handler: ({ body, req }) => refresh(body.refreshToken, clientOf(req)),
  }),
  defineRoute({
    method: 'post', path: '/auth/logout', tag: 'Auth', summary: 'Log out this device',
    access: 'user',
    handler: async ({ auth }) => { await logout(auth); },
  }),
  defineRoute({
    method: 'get', path: '/auth/me', tag: 'Auth', summary: 'Who am I and what am I allowed to do',
    access: 'user',
    handler: ({ auth }) => toMe(auth),
  }),
  defineRoute({
    method: 'post', path: '/auth/change-password', tag: 'Auth', summary: 'Change my password (logs out other devices)',
    access: 'user', body: changePasswordInput,
    handler: async ({ auth, body, req }) => { await changePassword(auth, body.currentPassword, body.newPassword, clientOf(req)); },
  }),

  defineRoute({
    method: 'post', path: '/auth/forgot-password', tag: 'Auth', summary: 'Request a temporary password (prints to console in dev)',
    access: 'public', limiter: 'login', body: z.object({ identifier: z.string().trim().min(1).max(254) }),
    handler: async ({ body }) => { await forgotPassword(body.identifier); },
  }),

  // ---------- Advisor self-registration ----------
  defineRoute({
    method: 'post', path: '/auth/register', tag: 'Registration', summary: 'Register as an advisor (sends mobile OTP)',
    access: 'public', limiter: 'register', body: registerInput, status: 201,
    handler: ({ body, req }) => register(body, clientOf(req)),
  }),
  defineRoute({
    method: 'post', path: '/auth/otp/request', tag: 'Registration', summary: 'Resend the OTP (after 30 seconds)',
    access: 'public', limiter: 'otp', body: resendInput,
    handler: ({ body }) => resendOtp(body.challengeId),
  }),
  defineRoute({
    method: 'post', path: '/auth/otp/verify', tag: 'Registration', summary: 'Verify the mobile OTP (starts the free trial)',
    access: 'public', limiter: 'otp', body: verifyInput,
    handler: ({ body, req }) => verifyOtp(body.challengeId, body.code, clientOf(req)),
  }),
  defineRoute({
    method: 'get', path: '/auth/registrations/:userId/status', tag: 'Registration', summary: 'Registration status (pending / active / rejected)',
    access: 'public', limiter: 'publicRead', params: z.object({ userId: objectId }),
    handler: ({ params }) => registrationStatus(params.userId),
  }),
];