import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const DOCUMENT_TYPES = ['Aadhaar', 'PAN', 'Passport', 'Photo', 'Address proof', 'Income proof', 'Medical report', 'Previous policy', 'Other'] as const;
export const DOCUMENT_STATUSES = ['Uploaded', 'Review Required', 'Verified', 'Rejected'] as const;

const documentSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    type: { type: String, enum: DOCUMENT_TYPES, required: true },
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'Review Required' },
    storageKey: { type: String, required: true, select: false }, // where the file is; never sent to the app
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
  },
  { timestamps: true },
);

documentSchema.index({ orgId: 1, customerId: 1, createdAt: -1 });
documentSchema.index({ orgId: 1, status: 1 });

export type DocumentDoc = InferSchemaType<typeof documentSchema> & { _id: Types.ObjectId; createdAt: Date };
export const CustomerDocument = model('CustomerDocument', documentSchema);
