import { Schema, model } from 'mongoose';

// Referral codes an advisor hands out (full referral tracking comes in Backend Part 4).
// A lead with source "Referral" must carry an active code of the same organization.
const referralCodeSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    active: { type: Boolean, default: true },
    ownerCustomerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null }, // who referred
  },
  { timestamps: true },
);

referralCodeSchema.index({ orgId: 1, code: 1 }, { unique: true });

export const ReferralCode = model('ReferralCode', referralCodeSchema);
