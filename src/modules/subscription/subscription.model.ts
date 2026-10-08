import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

// One subscription per advisor organization (staff use their advisor's plan)
const subscriptionSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, unique: true },
    planId: { type: String, enum: ['trial', 'basic', 'pro'], required: true },
    cycle: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
    status: { type: String, enum: ['TRIAL', 'ACTIVE', 'CANCELLED'], required: true }, // EXPIRED is worked out from the dates
    currentPeriodEnd: { type: Date, required: true },
    autoRenew: { type: Boolean, default: false },
  },
  { timestamps: true },
);
export type SubscriptionDoc = InferSchemaType<typeof subscriptionSchema> & { _id: Types.ObjectId };
export const Subscription = model('Subscription', subscriptionSchema);

// A plan purchase in progress (paid through the same payment provider as customer premiums)
const checkoutSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    planId: { type: String, enum: ['basic', 'pro'], required: true },
    cycle: { type: String, enum: ['monthly', 'yearly'], required: true },
    amount: { type: Number, required: true },
    gst: { type: Number, required: true },
    total: { type: Number, required: true },
    status: { type: String, enum: ['PENDING', 'PAID', 'FAILED'], default: 'PENDING' },
    provider: { type: String, required: true },
    providerLinkId: { type: String, required: true, unique: true },
    url: { type: String, required: true },
    expiresAt: { type: Date, default: null }, // when the payment link stops working (older checkouts: 1 day after creation)
    automatic: { type: Boolean, default: false }, // true = created by the plan-renewal reminder job
    transactionRef: { type: String, default: null },
    paidAt: { type: Date, default: null },
  },
  { timestamps: true },
);
export type CheckoutDoc = InferSchemaType<typeof checkoutSchema> & { _id: Types.ObjectId };
export const SubscriptionCheckout = model('SubscriptionCheckout', checkoutSchema);

const invoiceSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
    number: { type: String, required: true, unique: true },
    checkoutId: { type: Schema.Types.ObjectId, ref: 'SubscriptionCheckout', default: null },
    planName: { type: String, required: true },
    cycle: { type: String, required: true },
    amount: { type: Number, required: true },
    gst: { type: Number, required: true },
    total: { type: Number, required: true },
    paidAt: { type: Date, required: true },
  },
  { timestamps: true },
);
// One invoice per paid checkout (a repeated payment confirmation cannot create a second one)
invoiceSchema.index({ checkoutId: 1 }, { unique: true, partialFilterExpression: { checkoutId: { $type: 'objectId' } } });
export type InvoiceDoc = InferSchemaType<typeof invoiceSchema> & { _id: Types.ObjectId };
export const Invoice = model('Invoice', invoiceSchema);
