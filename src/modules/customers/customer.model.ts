import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

const customerSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    mobile: { type: String, required: true }, // +91XXXXXXXXXX
    email: { type: String, default: null },
    dob: { type: String, default: null }, // YYYY-MM-DD (a calendar date, no time zone)
    city: { type: String, default: null },
    pin: { type: String, default: null },
    source: { type: String, default: 'Direct' },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead', default: null },
    consentGiven: { type: Boolean, default: false },
    consentAt: { type: Date, default: null },
    nomineePercentTotal: { type: Number, default: 0, min: 0, max: 100 }, // kept in step with the nominees collection
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

customerSchema.index({ orgId: 1, mobile: 1 }, { unique: true });
customerSchema.index({ orgId: 1, name: 1 });

export type CustomerDoc = InferSchemaType<typeof customerSchema> & { _id: Types.ObjectId; createdAt: Date; updatedAt: Date };
export const Customer = model('Customer', customerSchema);
