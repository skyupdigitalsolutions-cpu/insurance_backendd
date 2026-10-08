import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { INSURANCE_TYPES } from '../customers/related.models.js';

// The product catalogue is shared by all advisors and maintained by platform admins.
// `null` means "information not available": the app shows "Not available" and never invents a value.
// Every change raises `version`; quotations keep their own copy (snapshot), so old quotes never change.
const addOnSchema = new Schema({ name: { type: String, required: true }, premium: { type: Number, required: true, min: 0 } });

const productSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    companyName: { type: String, required: true, trim: true },
    type: { type: String, enum: INSURANCE_TYPES, required: true },
    basePremium: { type: Number, default: null, min: 0 }, // yearly, rupees
    coverage: { type: String, default: null },
    features: { type: [String], default: [] },
    addOns: { type: [addOnSchema], default: [] },
    exclusions: { type: String, default: null },
    eligibility: { type: String, default: null },
    minAge: { type: Number, default: null },
    maxAge: { type: Number, default: null },
    source: { type: String, default: null }, // where the data comes from (brochure, page)
    active: { type: Boolean, default: true },
    version: { type: Number, default: 1 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

productSchema.index({ type: 1, active: 1, name: 1 });

export type ProductDoc = InferSchemaType<typeof productSchema> & { _id: Types.ObjectId; addOns: { _id: Types.ObjectId; name: string; premium: number }[] };
export const Product = model('Product', productSchema);
