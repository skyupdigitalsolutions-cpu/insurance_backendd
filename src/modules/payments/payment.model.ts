import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const PAYMENT_STATUSES = ['PENDING', 'SUCCESS', 'FAILED'] as const;

const paymentSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    quotationId: { type: Schema.Types.ObjectId, ref: 'Quotation', required: true },
    quoteNumber: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true },
    amount: { type: Number, required: true }, // rupees, copied from the quotation
    method: { type: String, required: true },  // what the advisor chose (link, UPI, card …)
    status: { type: String, enum: PAYMENT_STATUSES, default: 'PENDING' },
    provider: { type: String, enum: ['mock', 'razorpay'], required: true },
    providerLinkId: { type: String, default: null },
    link: { type: String, default: null },
    linkExpiresAt: { type: Date, default: null },
    transactionRef: { type: String, default: null }, // provider's payment id
    paidAt: { type: Date, default: null },
    failureReason: { type: String, default: null },
    attempts: [{ _id: false, providerLinkId: String, link: String, createdAt: Date, outcome: String }],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

paymentSchema.index({ orgId: 1, createdAt: -1 });
paymentSchema.index({ 'attempts.providerLinkId': 1 });
paymentSchema.index({ status: 1, linkExpiresAt: 1 }); // expiry and reminder jobs
paymentSchema.index({ providerLinkId: 1 }, { unique: true, partialFilterExpression: { providerLinkId: { $type: 'string' } } });
// At most one open payment and at most one successful payment per quotation
paymentSchema.index({ quotationId: 1 }, { unique: true, name: 'one_pending_per_quote', partialFilterExpression: { status: 'PENDING' } });
paymentSchema.index({ quotationId: 1, status: 1 }, { unique: true, name: 'one_success_per_quote', partialFilterExpression: { status: 'SUCCESS' } });

export type PaymentDoc = InferSchemaType<typeof paymentSchema> & { _id: Types.ObjectId; createdAt: Date };
export const Payment = model('Payment', paymentSchema);

// Every provider event we processed, so a repeated webhook is applied only once
const paymentEventSchema = new Schema(
  {
    eventId: { type: String, required: true, unique: true },
    provider: { type: String, required: true },
    event: { type: String, required: true },
    paymentId: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
    result: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
export const PaymentEvent = model('PaymentEvent', paymentEventSchema);
