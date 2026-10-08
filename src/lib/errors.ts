import type { Request } from 'express';

// One error type for every business-rule failure.
// The error middleware turns it into: { code, message, details?, requestId }
// `message` is always safe to show to the user as-is.
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, code = 'BAD_REQUEST', details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Session expired. Please log in again.', code = 'UNAUTHENTICATED') =>
  new AppError(401, code, message);
export const forbidden = (message = "You don't have permission to do this.", code = 'FORBIDDEN') =>
  new AppError(403, code, message);
export const notFound = (message = 'Not found', code = 'NOT_FOUND') => new AppError(404, code, message);
export const conflict = (message: string, code = 'CONFLICT') => new AppError(409, code, message);
export const tooManyRequests = (message: string, code = 'RATE_LIMITED') => new AppError(429, code, message);

// pino-http gives every request an id (also sent back in the X-Request-Id header)
export const requestIdOf = (req: Request): string =>
  typeof req.id === 'string' || typeof req.id === 'number' ? String(req.id) : '';
