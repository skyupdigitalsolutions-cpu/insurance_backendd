import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

// Records that belong to one customer. Each is its own collection (SRS §6: no giant customer document).
export const RELATIONSHIPS = ['Spouse', 'Son', 'Daughter', 'Father', 'Mother', 'Other'] as const;
export const INSURANCE_TYPES = ['Health', 'Life', 'Motor'] as const;
export const CONSENT_PURPOSES = ['data-processing', 'marketing'] as const;

const owned = {
  orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
  customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
};

// ---- Consent: append-only proof of what the customer agreed to, when, and who recorded it ----
const consentSchema = new Schema(
  {
    ...owned,
    purpose: { type: String, enum: CONSENT_PURPOSES, required: true },
    givenAt: { type: Date, required: true }, // server time, never the phone's
    recordedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },
  { versionKey: false },
);
export const Consent = model('Consent', consentSchema);

// ---- Family members ----
const familyMemberSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true },
    relationship: { type: String, enum: RELATIONSHIPS, required: true },
    dob: { type: String, default: null },
  },
  { timestamps: true },
);
export type FamilyMemberDoc = InferSchemaType<typeof familyMemberSchema> & { _id: Types.ObjectId };
export const FamilyMember = model('FamilyMember', familyMemberSchema);

// ---- Nominees (total share per customer ≤ 100 %) ----
const nomineeSchema = new Schema(
  {
    ...owned,
    name: { type: String, required: true, trim: true },
    relationship: { type: String, enum: RELATIONSHIPS, required: true },
    percent: { type: Number, required: true, min: 1, max: 100 },
  },
  { timestamps: true },
);
export type NomineeDoc = InferSchemaType<typeof nomineeSchema> & { _id: Types.ObjectId };
export const Nominee = model('Nominee', nomineeSchema);

// ---- Need analysis (one per customer, replaced on save) ----
const needAnalysisSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, unique: true },
    insuranceType: { type: String, enum: INSURANCE_TYPES, required: true },
    need: { type: String, required: true },
    coverage: { type: Number, default: null },
    budget: { type: Number, default: null },
    members: { type: Number, default: null },
    notes: { type: String, default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);
export type NeedAnalysisDoc = InferSchemaType<typeof needAnalysisSchema> & { _id: Types.ObjectId; updatedAt: Date };
export const NeedAnalysis = model('NeedAnalysis', needAnalysisSchema);
