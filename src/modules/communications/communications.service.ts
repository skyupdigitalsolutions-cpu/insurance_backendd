import { Types } from 'mongoose';
import { formatDate, todayInIndia } from '../../lib/dates.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { AuthContext } from '../../middleware/auth.js';
import { logEvent } from '../activities/activities.service.js';
import type { CustomerDoc } from '../customers/customer.model.js';
import { customerOrThrow } from '../customers/customers.service.js';
import { Policy } from '../policies/policy.model.js';
import { messageChannel } from './channels.js';
import { Message, Template, type MessageDoc, type TemplateDoc } from './communication.models.js';

const toTemplate = (t: TemplateDoc) => ({ id: t._id.toString(), name: t.name, event: t.event, channel: t.channel, body: t.body });

// Templates the advisor can send by hand (automatic-only templates, e.g. payment reminders, are not listed)
export async function listTemplates(orgId: Types.ObjectId) {
  const items = await Template.find({ approved: true, manual: { $ne: false }, $or: [{ orgId: null }, { orgId }] })
    .sort({ event: 1, name: 1 }).lean<TemplateDoc[]>();
  return { items: items.map(toTemplate) };
}

async function templateOrThrow(orgId: Types.ObjectId, id: string) {
  const t = Types.ObjectId.isValid(id) ? await Template.findOne({ _id: id, approved: true, $or: [{ orgId: null }, { orgId }] }).lean<TemplateDoc>() : null;
  if (!t) throw notFound('Template not found');
  return t;
}

// The approved template for an event (the advisor's own first, else the company's)
export async function templateForEvent(orgId: Types.ObjectId, event: string): Promise<TemplateDoc | null> {
  const list = await Template.find({ event, approved: true, $or: [{ orgId }, { orgId: null }] }).lean<TemplateDoc[]>();
  return list.find((t) => t.orgId?.equals(orgId)) ?? list[0] ?? null;
}

export type TemplateVars = Partial<Record<'name' | 'policy' | 'due' | 'amount' | 'quote' | 'link', string>>;
const PLACEHOLDER = /{{(\w+)}}/g;
const FALLBACK: Record<string, string> = { policy: 'your policy', due: 'the due date', amount: 'the amount', quote: 'your quotation', link: 'the payment link' };

// Fills {{placeholders}}; also returns the values in order of appearance (WhatsApp template {{1}}, {{2}} …)
export function fillTemplate(body: string, vars: TemplateVars): { text: string; params: string[] } {
  const params: string[] = [];
  const text = body.replace(PLACEHOLDER, (_m, key: string) => {
    const value = vars[key as keyof TemplateVars] ?? FALLBACK[key] ?? '';
    params.push(value);
    return value;
  });
  return { text, params };
}

// Values for a customer: first name, and their next policy to renew (soonest end date from today, else the latest)
async function customerVars(orgId: Types.ObjectId, c: CustomerDoc): Promise<TemplateVars> {
  const policies = await Policy.find({ orgId, customerId: c._id, status: 'ACTIVE' }).sort({ endDate: 1 }).lean();
  const pol = policies.find((p) => (p.endDate ?? '') >= todayInIndia()) ?? policies.at(-1);
  return {
    name: c.name.split(' ')[0] ?? c.name,
    ...(pol?.policyNumber ? { policy: pol.policyNumber } : {}),
    ...(pol?.endDate ? { due: formatDate(pol.endDate) } : {}),
  };
}

export async function previewMessage(orgId: Types.ObjectId, templateId: string, customerId: string) {
  const t = await templateOrThrow(orgId, templateId);
  const c = await customerOrThrow(orgId, customerId);
  return { text: fillTemplate(t.body, await customerVars(orgId, c)).text };
}

const toMessage = (m: MessageDoc) => ({
  id: m._id.toString(), customerId: m.customerId.toString(), customerName: m.customerName, channel: m.channel,
  templateName: m.templateName, text: m.text, status: m.status, sentAt: m.createdAt,
});

// Why a customer cannot get this template right now (null = OK). Same rule for manual and automatic messages.
export function blockedReason(t: TemplateDoc, c: CustomerDoc): { code: string; message: string } | null {
  if (t.channel === 'WhatsApp' && !c.consentGiven) return { code: 'NO_CONSENT', message: `${c.name} has not given consent for WhatsApp messages.` };
  if (t.channel === 'Email' && !c.email) return { code: 'NO_EMAIL', message: `${c.name} has no email address.` };
  return null;
}

// Sends one template message and stores the result. Used by the app (sentBy = user) and by reminder jobs (sentBy = null).
export async function deliver(input: {
  orgId: Types.ObjectId; customer: CustomerDoc; template: TemplateDoc; vars?: TemplateVars; sentBy: Types.ObjectId | null;
}): Promise<MessageDoc> {
  const { orgId, customer: c, template: t } = input;
  const { text, params } = fillTemplate(t.body, { ...(await customerVars(orgId, c)), ...input.vars });
  const to = t.channel === 'Email' ? c.email! : c.mobile;

  let status: 'Sent' | 'Failed' = 'Sent';
  let providerMessageId: string | null = null;
  let error: string | null = null;
  try {
    providerMessageId = (await messageChannel.send({
      channel: t.channel, to, text, subject: t.name,
      ...(t.waTemplateName ? { whatsapp: { templateName: t.waTemplateName, language: t.waLanguage ?? 'en', params } } : {}),
    })).providerMessageId;
  } catch (err) {
    logger.error({ err }, 'Message sending failed');
    status = 'Failed';
    error = err instanceof Error ? err.message : 'Unknown error';
  }
  const m = await Message.create({
    orgId, customerId: c._id, customerName: c.name, channel: t.channel, to, templateId: t._id, templateName: t.name, text,
    status, providerMessageId, error, sentBy: input.sentBy, automatic: !input.sentBy,
  });
  if (status === 'Sent') {
    await logEvent({
      orgId, entityType: 'Customer', entityId: c._id, actorUserId: input.sentBy ?? undefined,
      text: `${t.channel} "${t.name}" ${input.sentBy ? 'sent' : 'sent automatically'} to ${c.name}`,
    });
  }
  return m.toObject<MessageDoc>();
}

// Only approved templates, only to customers who may be contacted on that channel
export async function sendMessage(auth: AuthContext, orgId: Types.ObjectId, customerId: string, templateId: string) {
  const t = await templateOrThrow(orgId, templateId);
  const c = await customerOrThrow(orgId, customerId);
  const blocked = blockedReason(t, c);
  if (blocked) throw badRequest(blocked.message, blocked.code);
  return toMessage(await deliver({ orgId, customer: c, template: t, sentBy: auth.userId }));
}

export async function listMessages(orgId: Types.ObjectId) {
  const items = await Message.find({ orgId }).sort({ createdAt: -1, _id: -1 }).limit(200).lean<MessageDoc[]>();
  return { items: items.map(toMessage) };
}

// Delivery updates from the WhatsApp webhook: sent → delivered → read, or failed
export async function applyDeliveryStatus(providerMessageId: string, status: string, errorText?: string): Promise<boolean> {
  if (status === 'delivered' || status === 'read') {
    const r = await Message.updateOne({ providerMessageId, status: { $ne: 'Failed' } }, { $set: { status: 'Delivered' } });
    await Message.updateOne({ providerMessageId, deliveredAt: null }, { $set: { deliveredAt: new Date() } }); // first update wins
    return r.matchedCount === 1;
  }
  if (status === 'failed') {
    const r = await Message.updateOne({ providerMessageId }, { $set: { status: 'Failed', error: errorText ?? 'Not delivered' } });
    return r.matchedCount === 1;
  }
  return false; // "sent" is what we already store
}
