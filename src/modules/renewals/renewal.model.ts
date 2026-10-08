import { Schema, model } from 'mongoose';

// Renewal workflow state of one policy (only what cannot be worked out from other data)
const renewalStateSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    policyId: { type: Schema.Types.ObjectId, ref: 'Policy', required: true, unique: true },
    closedReason: { type: String, default: null }, // "customer moved insurer", "sold the car" …
    closedAt: { type: Date, default: null },
    closedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
export const RenewalState = model('RenewalState', renewalStateSchema);
