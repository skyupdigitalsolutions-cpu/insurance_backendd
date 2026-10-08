import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const CALL_OUTCOMES = ['Connected', 'No answer', 'Busy', 'Call back', 'Not interested', 'Wrong number'] as const;

// One row per call made from an Autodial session
const callLogSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['lead', 'renewal'], required: true },
    refId: { type: Schema.Types.ObjectId, required: true }, // lead id or policy id
    name: { type: String, required: true },
    mobile: { type: String, required: true },
    outcome: { type: String, enum: CALL_OUTCOMES, required: true },
    notes: { type: String, default: null },
    durationSec: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
callLogSchema.index({ orgId: 1, createdAt: -1 });

export type CallLogDoc = InferSchemaType<typeof callLogSchema> & { _id: Types.ObjectId; createdAt: Date };
export const CallLog = model('CallLog', callLogSchema);
