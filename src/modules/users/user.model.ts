import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

// Account life cycle (SRS §10 advisor states):
//   PENDING_OTP           registered, mobile not verified yet
//   PENDING_VERIFICATION  mobile verified, waiting for admin approval (KYC / IRDAI check)
//   ACTIVE                can log in
//   REJECTED              admin rejected the registration
//   INACTIVE              switched off by the advisor (staff) or admin
export const USER_STATUSES = ['PENDING_OTP', 'PENDING_VERIFICATION', 'ACTIVE', 'REJECTED', 'INACTIVE'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

const userSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    mobile: { type: String, required: true, unique: true }, // E.164: +919876543210
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: USER_STATUSES, required: true },
    isPlatformAdmin: { type: Boolean, default: false },
    mustChangePassword: { type: Boolean, default: false },
    mobileVerifiedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    rejectedReason: { type: String, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.index({ status: 1, createdAt: -1 }); // admin "pending registrations" list

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const User = model('User', userSchema);
