import type { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { env } from '../config/env.js';
import { ZodError } from 'zod';
import { AppError, requestIdOf } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

type ErrorBody = { code: string; message: string; details?: unknown; requestId?: string };

// Unknown URL
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found`, requestId: requestIdOf(req) });
}

// Every error ends here and leaves the server in the same shape: { code, message, details?, requestId }
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = requestIdOf(req);
  let status = 500;
  let body: ErrorBody = { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' };

  if (err instanceof AppError) {
    status = err.status;
    body = { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) };
  } else if (err instanceof ZodError) {
    status = 400;
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    body = { code: 'VALIDATION_ERROR', message: details[0]?.message ?? 'Invalid input', details };
  } else if (isBodyParserError(err)) {
    status = err.status;
    body = { code: 'BAD_REQUEST', message: err.type === 'entity.too.large' ? 'Request is too large' : 'Request body is not valid JSON' };
  } else if (err instanceof multer.MulterError) {
    status = 400;
    body = {
      code: 'UPLOAD_ERROR',
      message: err.code === 'LIMIT_FILE_SIZE' ? `File is too large (max ${env.MAX_UPLOAD_MB} MB).` : 'Upload one file in the "file" field.',
    };
  } else if (isDuplicateKeyError(err)) {
    status = 409;
    body = { code: 'CONFLICT', message: 'This record already exists.' };
  } else if (err instanceof mongoose.Error.CastError) {
    status = 400;
    body = { code: 'BAD_REQUEST', message: 'Invalid id' };
  }

  if (status >= 500) logger.error({ err, requestId }, 'Unhandled error');
  res.status(status).json({ ...body, requestId });
}

function isBodyParserError(err: unknown): err is { status: number; type: string } {
  return typeof err === 'object' && err !== null && 'type' in err && 'status' in err &&
    typeof (err as { type: unknown }).type === 'string' && (err as { type: string }).type.startsWith('entity.');
}

export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}
