import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

// One timeline for the whole organization.
//   CONTACT = a call / WhatsApp / email / meeting with a lead (shown on the lead screen)
//   EVENT   = something that happened (lead created, status changed, consent recorded …)
// The dashboard's "Recent activity" reads the latest entries of both kinds.
export const CONTACT_TYPES = ['Call', 'WhatsApp', 'Email', 'Meeting'] as const;
export const ENTITY_TYPES = ['Lead', 'Customer', 'Task', 'Policy'] as const;

const activitySchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    entityType: { type: String, enum: ENTITY_TYPES, required: true },
    entityId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ['CONTACT', 'EVENT'], required: true },
    type: { type: String, enum: [...CONTACT_TYPES, null], default: null }, // CONTACT only
    outcome: { type: String, default: null },                              // CONTACT only
    notes: { type: String, default: null },
    text: { type: String, required: true }, // one readable line for timelines
    actorUserId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    at: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);

activitySchema.index({ orgId: 1, at: -1 });
activitySchema.index({ entityType: 1, entityId: 1, at: -1 });

export type ActivityDoc = InferSchemaType<typeof activitySchema> & { _id: Types.ObjectId };
export const Activity = model('Activity', activitySchema);
