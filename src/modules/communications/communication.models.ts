import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

// Approved message templates (WhatsApp Business requires pre-approved templates).
// orgId = null → shared by every advisor (maintained by the company).
const templateSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', default: null },
    name: { type: String, required: true },
    event: { type: String, required: true }, // Renewal, Birthday, Quotation, Payment …
    channel: { type: String, enum: ['WhatsApp', 'Email'], required: true },
    body: { type: String, required: true }, // placeholders: {{name}} {{policy}} {{due}} {{amount}} {{quote}} {{link}}
    approved: { type: Boolean, default: true },
    manual: { type: Boolean, default: true }, // false = used only by automatic reminders (not listed in the app)
    // WhatsApp Cloud API: the template name approved in Meta Business Manager. Its {{1}}, {{2}} …
    // are our placeholders in the order they appear in `body`.
    waTemplateName: { type: String, default: null },
    waLanguage: { type: String, default: 'en' },
  },
  { timestamps: true },
);
export type TemplateDoc = InferSchemaType<typeof templateSchema> & { _id: Types.ObjectId };
export const Template = model('Template', templateSchema);

// Every message sent to a customer (what, to whom, by whom, result)
const messageSchema = new Schema(
  {
    orgId: { type: Schema.Types.ObjectId, ref: 'Organization', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String, required: true },
    channel: { type: String, enum: ['WhatsApp', 'Email'], required: true },
    to: { type: String, required: true },
    templateId: { type: Schema.Types.ObjectId, ref: 'Template', required: true },
    templateName: { type: String, required: true },
    text: { type: String, required: true },
    status: { type: String, enum: ['Sent', 'Delivered', 'Failed'], required: true },
    providerMessageId: { type: String, default: null },
    error: { type: String, default: null },
    deliveredAt: { type: Date, default: null }, // from the provider's delivery-status webhook
    sentBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }, // null = sent automatically by a reminder job
    automatic: { type: Boolean, default: false },
  },
  { timestamps: true },
);
messageSchema.index({ orgId: 1, createdAt: -1 });
messageSchema.index({ providerMessageId: 1 }, { partialFilterExpression: { providerMessageId: { $type: 'string' } } });
export type MessageDoc = InferSchemaType<typeof messageSchema> & { _id: Types.ObjectId; createdAt: Date };
export const Message = model('Message', messageSchema);
