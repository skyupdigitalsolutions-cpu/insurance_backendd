import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Customer } from '../src/modules/customers/customer.model.js';
import { DEMO, FILES, V1, api, bearer, closeConnections, registerAdvisor, resetDatabase, tokenOf } from './helpers.js';

beforeAll(async () => {
  await rm('./.test-uploads', { recursive: true, force: true });
  await resetDatabase();
});
afterAll(async () => {
  await closeConnections();
  await rm('./.test-uploads', { recursive: true, force: true });
});

const idOf = async (name: string) => (await Customer.findOne({ name }).lean())!._id.toString();
const upload = (token: string, customerId: string, file: Buffer, filename: string, type = 'Aadhaar') =>
  api().post(`${V1}/customers/${customerId}/documents`).set(bearer(token)).field('type', type).attach('file', file, filename);

describe('Upload', () => {
  it('needs the customer’s consent first', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const res = await upload(token, await idOf('Sneha Rao'), FILES.jpg, 'pan.jpg', 'PAN');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Record the customer's consent before uploading documents.");
  });

  it('uploads JPG, PNG and PDF; status starts as Review Required; returns a working view link', async () => {
    const token = await tokenOf(DEMO.staff.email);
    const ravi = await idOf('Ravi Kumar');
    for (const [file, name] of [[FILES.jpg, 'a.jpg'], [FILES.png, 'b.png'], [FILES.pdf, 'c.pdf']] as const) {
      const res = await upload(token, ravi, file, name);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.status).toBe('Review Required');
    }
    const list = await api().get(`${V1}/customers/${ravi}/documents`).set(bearer(token));
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items[0].mimeType).toBe('application/pdf'); // newest first
    expect(JSON.stringify(list.body)).not.toContain('storageKey');

    const url = new URL(list.body.items[0].uri as string);
    const file = await api().get(url.pathname + url.search); // no login header needed
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(file.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('refuses files that are not really JPG/PNG/PDF, empty uploads and wrong types', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const ravi = await idOf('Ravi Kumar');
    const fake = await upload(token, ravi, FILES.exe, 'photo.jpg');
    expect(fake.status).toBe(400);
    expect(fake.body.message).toBe('Only JPG, PNG or PDF files can be uploaded.');
    const noFile = await api().post(`${V1}/customers/${ravi}/documents`).set(bearer(token)).field('type', 'PAN');
    expect(noFile.body.message).toBe('Choose a file to upload.');
    const badType = await upload(token, ravi, FILES.jpg, 'x.jpg', 'Selfie');
    expect(badType.body.message).toBe('Choose a document type');
  });

  it('refuses files over the size limit', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const big = Buffer.concat([FILES.jpg, Buffer.alloc(10 * 1024 * 1024 + 1)]);
    const res = await upload(token, await idOf('Ravi Kumar'), big, 'big.jpg');
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('File is too large (max 10 MB).');
  });
});

describe('View links', () => {
  it('a changed or expired link does not work', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const list = await api().get(`${V1}/customers/${await idOf('Ravi Kumar')}/documents`).set(bearer(token));
    const url = new URL(list.body.items[0].uri as string);
    const sig = url.searchParams.get('sig')!;
    const expires = Number(url.searchParams.get('expires'));

    const tampered = await api().get(`${url.pathname}?expires=${expires + 3600}&sig=${sig}`);
    expect(tampered.status).toBe(403);
    const otherDoc = list.body.items[1].id as string;
    expect((await api().get(`${V1}/files/${otherDoc}?expires=${expires}&sig=${sig}`)).status).toBe(403);
    const expired = await api().get(`${url.pathname}?expires=1000&sig=${sig}`);
    expect(expired.status).toBe(403);
    expect(expired.body.message).toBe('This link has expired. Open the document again from the app.');
  });
});

describe('Review', () => {
  it('verifies or rejects once; rejection needs a reason', async () => {
    const token = await tokenOf(DEMO.advisor.email);
    const list = await api().get(`${V1}/customers/${await idOf('Ravi Kumar')}/documents`).set(bearer(token));
    const [first, second] = list.body.items as { id: string }[];

    const ok = await api().post(`${V1}/documents/${first!.id}/review`).set(bearer(token)).send({ decision: 'VERIFY' });
    expect(ok.body.status).toBe('Verified');
    const again = await api().post(`${V1}/documents/${first!.id}/review`).set(bearer(token)).send({ decision: 'REJECT', reason: 'Blurry' });
    expect(again.status).toBe(409);

    const noReason = await api().post(`${V1}/documents/${second!.id}/review`).set(bearer(token)).send({ decision: 'REJECT' });
    expect(noReason.body.message).toBe('Give a reason for rejecting the document.');
    const rejected = await api().post(`${V1}/documents/${second!.id}/review`).set(bearer(token)).send({ decision: 'REJECT', reason: 'Photo is blurry' });
    expect(rejected.body).toMatchObject({ status: 'Rejected', rejectReason: 'Photo is blurry' });
  });

  it('another advisor cannot list, upload to, or review these documents', async () => {
    const { input } = await registerAdvisor({ approve: true });
    const other = await tokenOf(input.email, input.password);
    const ravi = await idOf('Ravi Kumar');
    expect((await api().get(`${V1}/customers/${ravi}/documents`).set(bearer(other))).status).toBe(404);
    expect((await upload(other, ravi, FILES.jpg, 'x.jpg')).status).toBe(404);
    const owner = await tokenOf(DEMO.advisor.email);
    const docs = await api().get(`${V1}/customers/${ravi}/documents`).set(bearer(owner));
    expect((await api().post(`${V1}/documents/${docs.body.items[2].id}/review`).set(bearer(other)).send({ decision: 'VERIFY' })).status).toBe(404);
  });
});
