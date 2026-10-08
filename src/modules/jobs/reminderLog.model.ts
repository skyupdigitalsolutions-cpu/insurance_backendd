import { Schema, model, type Types } from 'mongoose';
import { isDuplicateKeyError } from '../../middleware/error.js';

// One row per automatic reminder already handled, so a job that runs twice (retry, second worker,
// manual "Run now") never messages the same customer twice. The unique key is the lock.
//   renewal:<policyId>:<daysBefore>   birthday:<customerId>:<year>   payment:<paymentId>:<linkId>
//   plan:<subscriptionId>:<periodEnd> trial:<subscriptionId>
const reminderLogSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    kind: { type: String, required: true },
    action: { type: String, required: true }, // message | task | sms | skipped
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
reminderLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 86_400 }); // kept a little over a year

export const ReminderLog = model('ReminderLog', reminderLogSchema);

// Claims a reminder: true the first time a key is seen, false if it was already handled
export async function claimReminder(key: string, orgId: Types.ObjectId | null, kind: string, action: string): Promise<boolean> {
  try {
    await ReminderLog.create({ key, orgId, kind, action });
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}
