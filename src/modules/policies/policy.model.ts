import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

// Created automatically when a payment succeeds (PENDING_ISSUANCE); becomes ACTIVE when issued
const policySchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    policyNumber: { type: String, default: null },
    quotationId: { type: Schema.Types.ObjectId, ref: 'Quotation', required: true, unique: true }, // one policy per paid quotation
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null }, // null for policies sold before the platform
    source: { type: String, enum: ['PLATFORM', 'IMPORTED'], default: 'PLATFORM' },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    companyName: { type: String, required: true },
    type: { type: String, required: true },
    premium: { type: Number, required: true },
    frequency: { type: String, required: true },
    status: { type: String, enum: ['PENDING_ISSUANCE', 'ACTIVE'], default: 'PENDING_ISSUANCE' },
    startDate: { type: String, default: null }, // YYYY-MM-DD (Indian calendar date)
    endDate: { type: String, default: null },
    issuedAt: { type: Date, default: null },
    issuedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

policySchema.index({ orgId: 1, customerId: 1, createdAt: -1 });
policySchema.index({ orgId: 1, status: 1, endDate: 1 }); // renewals (Part 4)

export type PolicyDoc = InferSchemaType<typeof policySchema> & { _id: Types.ObjectId; createdAt: Date };
export const Policy = model('Policy', policySchema);
