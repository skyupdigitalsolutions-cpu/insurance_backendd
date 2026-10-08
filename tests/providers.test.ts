// Part 5: real providers behind their switches, tested against local stand-ins:
// MSG91 (SMS), WhatsApp Cloud API (send + signed delivery webhooks), SMTP (email) and S3 storage.
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as Helpers from './helpers.js';
import type { Message as MessageModel, Template as TemplateModel } from '../src/modules/communications/communication.models.js';
import type * as SmsModule from '../src/modules/auth/sms.js';
import type * as StorageModule from '../src/lib/storage.js';

const APP_SECRET = 'meta-app-secret-for-tests';
const VERIFY_TOKEN = 'verify-token-for-tests';
type Call = { url: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> };
const calls: Call[] = [];
const mails: string[] = [];
let msg91Fails = false;
let http: Server;
let smtp: TcpServer;

let h: typeof Helpers;
let Message: typeof MessageModel;
let Template: typeof TemplateModel;
let smsModule: typeof SmsModule;
let storageModule: typeof StorageModule;

// A minimal SMTP server: accepts one message per connection and keeps the raw text
function fakeSmtp(): TcpServer {
  return createTcpServer((socket) => {
    let inData = false;
    let data = '';
    socket.write('220 fake-smtp ready\r\n');
    socket.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\r\n')) {
        if (inData) {
          if (line === '.') { inData = false; mails.push(data); socket.write('250 OK queued\r\n'); } else data += `${line}\n`;
          continue;
        }
        if (/^(EHLO|HELO)/i.test(line)) socket.write('250-fake-smtp\r\n250 OK\r\n');
        else if (/^(MAIL|RCPT)/i.test(line)) socket.write('250 OK\r\n');
        else if (/^DATA/i.test(line)) { inData = true; data = ''; socket.write('354 End with .\r\n'); }
        else if (/^QUIT/i.test(line)) socket.end('221 Bye\r\n');
        else if (line) socket.write('250 OK\r\n');
      }
    });
  });
}

beforeAll(async () => {
  // One HTTP stand-in for MSG91 (/api/v5/flow) and the WhatsApp Graph API (/<phone-id>/messages)
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => { raw += c.toString(); });
    req.on('end', () => {
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
      calls.push({ url: req.url ?? '', headers: req.headers, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v5/flow') {
        res.end(JSON.stringify(msg91Fails ? { type: 'error', message: 'Template not approved' } : { type: 'success', message: 'req_123' }));
      } else if (req.url === '/PHONE123/messages') {
        res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.TEST${calls.length}` }] }));
      } else res.writeHead(404).end('{}');
    });
  });
  smtp = fakeSmtp();
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  Object.assign(process.env, {
    SMS_PROVIDER: 'msg91',
    MSG91_AUTH_KEY: 'msg91-test-key',
    MSG91_TEMPLATE_IDS: 'otp=T_OTP, account_approved=T_APPROVED, staff_invite=T_INVITE, plan_renewal=T_PLAN, trial_ending=T_TRIAL',
    MSG91_API_BASE: base,
    WHATSAPP_PROVIDER: 'meta',
    WHATSAPP_PHONE_NUMBER_ID: 'PHONE123',
    WHATSAPP_ACCESS_TOKEN: 'meta-token',
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
    WHATSAPP_API_BASE: base,
    EMAIL_PROVIDER: 'smtp',
    SMTP_URL: `smtp://127.0.0.1:${(smtp.address() as AddressInfo).port}`,
    EMAIL_FROM: 'Demo Advisor <advisor@example.com>',
  });
  h = await import('./helpers.js');
  ({ Message, Template } = await import('../src/modules/communications/communication.models.js'));
  smsModule = await import('../src/modules/auth/sms.js');
  storageModule = await import('../src/lib/storage.js');
  await h.resetDatabase();
});

afterAll(async () => {
  await h.closeConnections();
  await new Promise<void>((r) => http.close(() => r()));
  await new Promise<void>((r) => smtp.close(() => r()));
});

describe('SMS through MSG91 (DLT templates)', () => {
  it('the OTP goes out with the DLT template id, the number without "+", and the code as a variable', async () => {
    const { input } = await h.registerAdvisor();
    const call = calls.filter((c) => c.url === '/api/v5/flow').at(-1)!;
    expect(call.headers.authkey).toBe('msg91-test-key');
    expect(call.body).toMatchObject({ template_id: 'T_OTP', recipients: [{ mobiles: input.mobile.slice(1), code: h.OTP }] });
  });

  it('a refused SMS is reported as an error, and a missing template id stops start-up', async () => {
    msg91Fails = true;
    await expect(smsModule.sms.send('+919876543210', 'account_approved', {})).rejects.toMatchObject({ code: 'SMS_PROVIDER_ERROR' });
    msg91Fails = false;
    expect(() => smsModule.parseTemplateIds('otp=T1')).toThrow(/missing: account_approved, staff_invite, plan_renewal, trial_ending/);
  });

  it('the wording registered on DLT is the text we would send', () => {
    expect(smsModule.smsText('trial_ending', { date: '09 Oct 2026' }))
      .toBe('Your Insurance Advisor free trial ends on 09 Oct 2026. Open the app and go to Subscription to choose a plan.');
  });
});

describe('WhatsApp Cloud API', () => {
  const signed = (body: unknown, secret = APP_SECRET) => {
    const raw = JSON.stringify(body);
    return h.api().post(`${h.V1}/webhooks/whatsapp`).set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`).send(raw);
  };
  const statusEvent = (id: string, status: string) => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', statuses: [{ id, status, timestamp: '1700000000', recipient_id: '919876543210' }] } }] }],
  });

  let wamid = '';
  it('sends the approved template with the placeholders as {{1}}, {{2}}, {{3}}', async () => {
    const token = await h.tokenOf(h.DEMO.advisor.email);
    const t = (await Template.findOne({ name: 'Renewal reminder' }).lean())!;
    const res = await h.api().post(`${h.V1}/communications/send`).set(h.bearer(token))
      .send({ customerId: await h.customerId('Ravi Kumar'), templateId: t._id.toString() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('Sent');

    const call = calls.filter((c) => c.url === '/PHONE123/messages').at(-1)!;
    expect(call.headers.authorization).toBe('Bearer meta-token');
    const template = call.body.template as { name: string; language: { code: string }; components: { parameters: { text: string }[] }[] };
    expect(call.body).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210', type: 'template' });
    expect(template.name).toBe('renewal_reminder');
    expect(template.language.code).toBe('en');
    const params = template.components[0]!.parameters.map((p) => p.text);
    expect(params[0]).toBe('Ravi');
    expect(params[1]).toMatch(/^POL-/);
    expect(res.body.text).toBe(`Dear Ravi, your policy ${params[1]} is due for renewal on ${params[2]}. Reply YES and I will share the renewal quote.`);
    wamid = (await Message.findById(res.body.id).lean())!.providerMessageId!;
    expect(wamid).toMatch(/^wamid\./);
  });

  it('webhook verification answers Meta’s challenge only with the right token', async () => {
    const ok = await h.api().get(`${h.V1}/webhooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '98765' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('98765');
    const bad = await h.api().get(`${h.V1}/webhooks/whatsapp`).query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'guess', 'hub.challenge': '1' });
    expect(bad.status).toBe(403);
  });

  it('signed delivery updates mark the message delivered; forged ones are refused', async () => {
    expect((await signed(statusEvent(wamid, 'delivered'), 'wrong-secret')).status).toBe(400);
    const res = await signed(statusEvent(wamid, 'delivered'));
    expect(res.body).toEqual({ updated: 1 });
    const m = (await Message.findOne({ providerMessageId: wamid }).lean())!;
    expect(m.status).toBe('Delivered');
    expect(m.deliveredAt).toBeInstanceOf(Date);
    await signed(statusEvent(wamid, 'read'));
    expect((await Message.findOne({ providerMessageId: wamid }).lean())!.deliveredAt!.getTime()).toBe(m.deliveredAt!.getTime());
    expect((await signed(statusEvent('wamid.UNKNOWN', 'delivered'))).body).toEqual({ updated: 0 });
  });
});

describe('Email through SMTP', () => {
  it('sends from the configured address with the template name as subject', async () => {
    const token = await h.tokenOf(h.DEMO.advisor.email);
    const t = (await Template.findOne({ name: 'Quotation follow-up' }).lean())!;
    const res = await h.api().post(`${h.V1}/communications/send`).set(h.bearer(token))
      .send({ customerId: await h.customerId('Ravi Kumar'), templateId: t._id.toString() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('Sent');
    const mail = mails.at(-1)!;
    expect(mail).toContain('To: ravi@example.com');
    expect(mail).toContain('Subject: Quotation follow-up');
    expect(mail).toContain('advisor@example.com');
    expect(mail).toContain('following up on the quotation');
  });
});

describe('S3-compatible storage', () => {
  it('stores privately with encryption, streams back, deletes', async () => {
    const s3 = mockClient(S3Client);
    s3.on(PutObjectCommand).resolves({});
    s3.on(GetObjectCommand).resolves({ Body: Readable.from([Buffer.from('file-bytes')]) as never });
    s3.on(DeleteObjectCommand).resolves({});
    const store = new storageModule.S3Storage('kyc-bucket', new S3Client({ region: 'ap-south-1' }));

    await store.save('org1/doc1.pdf', Buffer.from('file-bytes'));
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input).toMatchObject({ Bucket: 'kyc-bucket', Key: 'org1/doc1.pdf', ServerSideEncryption: 'AES256' });
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input).not.toHaveProperty('ACL');

    const chunks: Buffer[] = [];
    for await (const c of await store.open('org1/doc1.pdf')) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('file-bytes');

    await store.remove('org1/doc1.pdf');
    expect(s3.commandCalls(DeleteObjectCommand)[0]!.args[0].input).toEqual({ Bucket: 'kyc-bucket', Key: 'org1/doc1.pdf' });
    s3.restore();
  });
});
