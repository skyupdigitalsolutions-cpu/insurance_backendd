// Customer message delivery.
//   WhatsApp: "console" (log only) or "meta" (official WhatsApp Cloud API, approved templates only)
//   Email:    "console" (log only) or "smtp" (any transactional email service: Amazon SES, Brevo, Zoho, Gmail Workspace …)
// The rest of the code only calls messageChannel.send(...).
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env.js';
import { randomToken } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

export type OutgoingMessage = {
  channel: 'WhatsApp' | 'Email';
  to: string; // +91XXXXXXXXXX for WhatsApp, an email address for Email
  text: string; // the filled-in message (stored, shown in the app, used as the email body)
  subject?: string;
  // WhatsApp only: the template name approved in Meta Business Manager and its {{1}}, {{2}} … values in order
  whatsapp?: { templateName: string; language: string; params: string[] };
};
export type SendResult = { providerMessageId: string };

interface Sender {
  send(m: OutgoingMessage): Promise<SendResult>;
}

class ConsoleSender implements Sender {
  send(m: OutgoingMessage): Promise<SendResult> {
    logger.info({ channel: m.channel, to: m.to, text: m.text }, 'Message (console channel, not really sent)');
    return Promise.resolve({ providerMessageId: `console_${randomToken(8)}` });
  }
}

// WhatsApp Cloud API. Business-initiated messages must use a template Meta has approved;
// the template's {{1}}, {{2}} … are filled with our placeholders in the order they appear in the body.
class MetaWhatsAppSender implements Sender {
  async send(m: OutgoingMessage): Promise<SendResult> {
    if (!m.whatsapp) throw new AppError(500, 'WHATSAPP_TEMPLATE_MISSING', 'This template has no WhatsApp template name.');
    let res: Response;
    try {
      res = await fetch(`${env.WHATSAPP_API_BASE}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: m.to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: m.whatsapp.templateName,
            language: { code: m.whatsapp.language },
            components: m.whatsapp.params.length
              ? [{ type: 'body', parameters: m.whatsapp.params.map((text) => ({ type: 'text', text })) }]
              : [],
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      logger.error({ err }, 'WhatsApp API not reachable');
      throw new AppError(502, 'WHATSAPP_DOWN', 'WhatsApp is not reachable right now.');
    }
    const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
    const id = body.messages?.[0]?.id;
    if (!res.ok || !id) {
      logger.error({ status: res.status, error: body.error }, 'WhatsApp refused the message');
      throw new AppError(502, 'WHATSAPP_ERROR', body.error?.message ?? 'WhatsApp refused the message.');
    }
    return { providerMessageId: id }; // "wamid…" — delivery updates arrive at /webhooks/whatsapp
  }
}

class SmtpEmailSender implements Sender {
  private readonly transport: Transporter = nodemailer.createTransport(env.SMTP_URL ?? '');

  async send(m: OutgoingMessage): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({ from: env.EMAIL_FROM, to: m.to, subject: m.subject ?? 'Message from your insurance advisor', text: m.text });
      return { providerMessageId: info.messageId };
    } catch (err) {
      logger.error({ err }, 'Email sending failed');
      throw new AppError(502, 'EMAIL_ERROR', 'The email could not be sent.');
    }
  }
}

const whatsapp: Sender = env.WHATSAPP_PROVIDER === 'meta' ? new MetaWhatsAppSender() : new ConsoleSender();
const email: Sender = env.EMAIL_PROVIDER === 'smtp' ? new SmtpEmailSender() : new ConsoleSender();

export const messageChannel = {
  send: (m: OutgoingMessage): Promise<SendResult> => (m.channel === 'WhatsApp' ? whatsapp : email).send(m),
};
