import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

// One document per logged-in device.
// The refresh token changes on every refresh (rotation). Only SHA-256 hashes are stored.
// If an old refresh token is used again after the grace period, it was probably stolen,
// so the whole session is revoked.
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    refreshTokenHash: { type: String, required: true, unique: true },
    previousTokenHash: { type: String, default: null, index: true },
    rotatedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
    lastUsedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

// MongoDB deletes expired sessions automatically, 7 days after expiry
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

export type SessionDoc = InferSchemaType<typeof sessionSchema> & { _id: Types.ObjectId };
export const Session = model('Session', sessionSchema);
