import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

// One organization per advisor (advisor-only model). Staff users belong to their advisor's organization.
// Almost every business record later carries orgId, so data from different advisors never mixes.
const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    irdaiNumber: { type: String, trim: true, default: null },
    trialStartedAt: { type: Date, default: null }, // set when the advisor verifies the mobile OTP
  },
  { timestamps: true },
);

export type OrganizationDoc = InferSchemaType<typeof organizationSchema> & { _id: Types.ObjectId };
export const Organization = model('Organization', organizationSchema);
