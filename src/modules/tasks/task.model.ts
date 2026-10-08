import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const TASK_TYPES = ['Call', 'Visit', 'Documents', 'Payment follow-up', 'Other'] as const;

const taskSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: TASK_TYPES, required: true },
    due: { type: Date, required: true },
    relatedTo: { type: String, default: null }, // e.g. "Lead: Meena Iyer"
    done: { type: Boolean, default: false },
    doneAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

taskSchema.index({ orgId: 1, done: 1, due: 1 });

export type TaskDoc = InferSchemaType<typeof taskSchema> & { _id: Types.ObjectId; createdAt: Date };
export const Task = model('Task', taskSchema);
