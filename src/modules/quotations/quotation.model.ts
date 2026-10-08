import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { INSURANCE_TYPES } from '../customers/related.models.js';

// DRAFT = waiting for discount approval · GENERATED → SENT → ACCEPTED → PAYMENT_PENDING → PAID
export const QUOTE_STATUSES = ['DRAFT', 'GENERATED', 'SENT', 'ACCEPTED', 'PAYMENT_PENDING', 'PAID', 'CANCELLED'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

// A quotation is a frozen copy (snapshot): later product or price changes never alter it
const quotationSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    quoteNumber: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    productVersion: { type: Number, required: true },
    product: {
      name: { type: String, required: true },
      companyName: { type: String, required: true },
      type: { type: String, enum: INSURANCE_TYPES, required: true },
      coverage: { type: String, default: null },
      features: { type: [String], default: [] },
      exclusions: { type: String, default: null },
    },
    addOns: [{ _id: false, id: String, name: String, premium: Number }],
    frequency: { type: String, enum: ['Yearly', 'Monthly'], required: true },
    discountPercent: { type: Number, default: 0 },
    discountReason: { type: String, default: null },
    approvalStatus: { type: String, enum: ['NONE', 'PENDING', 'APPROVED'], default: 'NONE' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    approvedAt: { type: Date, default: null },
    pricing: {
      base: { type: Number, required: true }, addOns: { type: Number, required: true }, subtotal: { type: Number, required: true },
      discount: { type: Number, required: true }, gst: { type: Number, required: true }, total: { type: Number, required: true },
      gstRate: { type: Number, required: true },
    },
    comparedProductIds: { type: [String], default: [] },
    status: { type: String, enum: QUOTE_STATUSES, required: true },
    validUntil: { type: Date, required: true },
    sentAt: { type: Date, default: null },
    sentVia: { type: String, default: null },
    acceptedAt: { type: Date, default: null },
    cancelReason: { type: String, default: null }, // e.g. "Expired" (set by the nightly clean-up job)
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

quotationSchema.index({ orgId: 1, quoteNumber: 1 }, { unique: true });
quotationSchema.index({ orgId: 1, customerId: 1, createdAt: -1 });
quotationSchema.index({ orgId: 1, createdAt: -1 });
quotationSchema.index({ status: 1, validUntil: 1 }); // nightly expiry job

type Snapshot = {
  name: string; companyName: string; type: 'Health' | 'Life' | 'Motor'; coverage: string | null; features: string[]; exclusions: string | null;
};
export type QuotePricing = { base: number; addOns: number; subtotal: number; discount: number; gst: number; total: number; gstRate: number };
export type QuotationDoc = Omit<InferSchemaType<typeof quotationSchema>, 'product' | 'pricing' | 'addOns'> & {
  _id: Types.ObjectId; createdAt: Date; product: Snapshot; pricing: QuotePricing; addOns: { id: string; name: string; premium: number }[];
};
export const Quotation = model('Quotation', quotationSchema);
