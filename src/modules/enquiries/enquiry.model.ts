import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

// Messages sent from the website's contact form (people interested in the platform)
export const ENQUIRY_STATUSES = ['NEW', 'CONTACTED', 'CLOSED'] as const;

const enquirySchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    mobile: { type: String, required: true },
    email: { type: String, default: null },
    city: { type: String, default: null },
    message: { type: String, required: true, maxlength: 1000 },
    status: { type: String, enum: ENQUIRY_STATUSES, default: 'NEW' },
    consentAt: { type: Date, required: true }, // agreed to be contacted
    ip: { type: String, default: null },
  },
  { timestamps: true },
);
enquirySchema.index({ status: 1, createdAt: -1 });

export type EnquiryDoc = InferSchemaType<typeof enquirySchema> & { _id: Types.ObjectId; createdAt: Date };
export const Enquiry = model('Enquiry', enquirySchema);
