import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

// A named set of permissions. Every advisor account (organization) has its own roles.
// Platform admin roles have orgId = null.
const roleSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null, index: true },
    key: { type: String, default: null }, // 'advisor' | 'staff' | 'platform_admin' for built-in roles
    name: { type: String, required: true, trim: true, maxlength: 50 },
    nameKey: { type: String, required: true }, // lower-case name, for "name already exists" checks
    permissions: { type: [String], default: [] },
    system: { type: Boolean, default: false }, // system roles cannot be edited
  },
  { timestamps: true },
);

roleSchema.index({ orgId: 1, nameKey: 1 }, { unique: true });

export type RoleDoc = InferSchemaType<typeof roleSchema> & { _id: Types.ObjectId };
export const Role = model('Role', roleSchema);
