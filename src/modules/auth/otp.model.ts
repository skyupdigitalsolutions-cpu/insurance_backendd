import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

// One OTP "challenge" per code sent. The code itself is never stored, only an HMAC of it.
const otpChallengeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    purpose: { type: String, enum: ['REGISTRATION'], required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    resendAvailableAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null }, // set when the code can no longer be used
    consumedReason: { type: String, enum: ['VERIFIED', 'RESENT', 'LOCKED', null], default: null },
  },
  { timestamps: true },
);

// Old challenges are removed automatically one day after they expire
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 24 * 3600 });

export type OtpChallengeDoc = InferSchemaType<typeof otpChallengeSchema> & { _id: Types.ObjectId };
export const OtpChallenge = model('OtpChallenge', otpChallengeSchema);
