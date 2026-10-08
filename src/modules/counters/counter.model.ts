import { Schema, model } from 'mongoose';

// Gap-free running numbers (quotation and policy numbers), one counter per advisor and year
const counterSchema = new Schema({ _id: { type: String, required: true }, seq: { type: Number, default: 0 } }, { versionKey: false });
const Counter = model('Counter', counterSchema);

// nextNumber('Q', orgId) → "Q-2026-00001", "Q-2026-00002", … (atomic, safe with parallel requests)
export async function nextNumber(prefix: string, orgId: { toString(): string }): Promise<string> {
  const year = new Date().getFullYear();
  const c = await Counter.findOneAndUpdate(
    { _id: `${prefix}:${orgId.toString()}:${year}` },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).lean();
  return `${prefix}-${year}-${String(c.seq).padStart(5, '0')}`;
}
