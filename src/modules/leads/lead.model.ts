import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'QUOTATION', 'FOLLOW_UP', 'CONVERTED', 'LOST'] as const;
export const LEAD_SOURCES = ['Referral', 'Paid Ads', 'Campaign', 'Other'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

const leadSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    mobile: { type: String, required: true }, // +91XXXXXXXXXX
    email: { type: String, default: null },
    source: { type: String, enum: LEAD_SOURCES, required: true },
    referralCode: { type: String, default: null },
    campaign: { type: String, default: null },
    requirement: { type: String, default: null },
    notes: { type: String, default: null },
    status: { type: String, enum: LEAD_STATUSES, default: 'NEW' },
    lostReason: { type: String, default: null },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null }, // set by "Convert to customer"
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

leadSchema.index({ orgId: 1, mobile: 1 }, { unique: true }); // one lead per mobile number per advisor
leadSchema.index({ orgId: 1, status: 1, createdAt: -1 });
leadSchema.index({ orgId: 1, createdAt: -1 });

export type LeadDoc = InferSchemaType<typeof leadSchema> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
export const Lead = model('Lead', leadSchema);
