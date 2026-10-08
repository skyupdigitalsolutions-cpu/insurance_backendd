import { pino } from 'pino';
import { env } from '../config/env.js';

// Structured JSON logs in staging/production; readable coloured logs on a developer laptop.
// Passwords, tokens and OTP codes are never written to the logs.
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.newPassword',
      '*.currentPassword',
      '*.refreshToken',
      '*.accessToken',
      '*.code',
    ],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } } }
    : {}),
});
