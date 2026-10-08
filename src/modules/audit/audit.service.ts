import type { Types } from 'mongoose';
import { logger } from '../../lib/logger.js';
import { AuditLog } from './audit.model.js';

export type AuditEntry = {
  orgId?: Types.ObjectId | null;
  actorUserId?: Types.ObjectId | null;
  action: string;
  entity: string;
  entityId?: Types.ObjectId | null;
  meta?: Record<string, unknown>;
  ip?: string | null;
  requestId?: string | null;
};

// An audit failure is logged but never breaks the user's request
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await AuditLog.create(entry);
  } catch (err) {
    logger.error({ err, action: entry.action }, 'Failed to write audit log');
  }
}
