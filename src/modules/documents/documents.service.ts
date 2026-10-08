import { randomUUID } from 'node:crypto';
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { hmacSha256, safeEqualHex } from '../../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { detectFileType, storage } from '../../lib/storage.js';
import type { AuthContext } from '../../middleware/auth.js';
import { logEvent } from '../activities/activities.service.js';
import { audit } from '../audit/audit.service.js';
import { customerOrThrow } from '../customers/customers.service.js';
import { CustomerDocument, type DocumentDoc } from './document.model.js';

const MAX_DOCUMENTS_PER_CUSTOMER = 50;

// ---------- signed, short-lived links to view a file ----------
// The app (or an <img> tag in the admin panel) can open the link without a login header,
// but it stops working after FILE_URL_TTL_SEC and cannot be changed to point at another file.
const signatureOf = (docId: string, expires: number) => hmacSha256(env.FILE_URL_SECRET, `${docId}:${expires}`);

export function signedFileUrl(baseUrl: string, docId: string): string {
  const expires = Math.floor(Date.now() / 1000) + env.FILE_URL_TTL_SEC;
  return `${baseUrl}/api/v1/files/${docId}?expires=${expires}&sig=${signatureOf(docId, expires)}`;
}

export function checkFileSignature(docId: string, expires: number, sig: string): void {
  if (expires < Math.floor(Date.now() / 1000)) throw forbidden('This link has expired. Open the document again from the app.', 'LINK_EXPIRED');
  if (!/^[a-f\d]{64}$/.test(sig) || !safeEqualHex(sig, signatureOf(docId, expires))) throw forbidden('Invalid link.', 'LINK_INVALID');
}

// Shape returned to the app (CustomerDocument type)
export const toDocument = (d: DocumentDoc, baseUrl: string) => ({
  id: d._id.toString(),
  customerId: d.customerId.toString(),
  type: d.type,
  uri: signedFileUrl(baseUrl, d._id.toString()),
  status: d.status,
  mimeType: d.mimeType,
  uploadedAt: d.createdAt,
  rejectReason: d.rejectReason ?? undefined,
});

export async function listDocuments(orgId: Types.ObjectId, customerId: string, baseUrl: string) {
  const c = await customerOrThrow(orgId, customerId);
  const docs = await CustomerDocument.find({ orgId, customerId: c._id }).sort({ createdAt: -1, _id: -1 }).lean<DocumentDoc[]>();
  return { items: docs.map((d) => toDocument(d, baseUrl)) };
}

export async function uploadDocument(
  auth: AuthContext, orgId: Types.ObjectId, customerId: string, type: DocumentDoc['type'],
  file: Express.Multer.File | undefined, baseUrl: string,
) {
  const customer = await customerOrThrow(orgId, customerId);
  if (!customer.consentGiven) {
    throw badRequest("Record the customer's consent before uploading documents.", 'CONSENT_REQUIRED');
  }
  if (!file?.buffer.length) throw badRequest('Choose a file to upload.', 'FILE_REQUIRED');
  const detected = detectFileType(file.buffer);
  if (!detected) throw badRequest('Only JPG, PNG or PDF files can be uploaded.', 'FILE_TYPE');
  if ((await CustomerDocument.countDocuments({ customerId: customer._id })) >= MAX_DOCUMENTS_PER_CUSTOMER) {
    throw badRequest(`A customer can have at most ${MAX_DOCUMENTS_PER_CUSTOMER} documents.`, 'DOCUMENT_LIMIT');
  }

  const storageKey = `${orgId.toString()}/${customer._id.toString()}/${randomUUID()}.${detected.ext}`;
  await storage.save(storageKey, file.buffer);
  try {
    const doc = await CustomerDocument.create({
      orgId, customerId: customer._id, type, status: 'Review Required', storageKey,
      mimeType: detected.mime, sizeBytes: file.size, uploadedBy: auth.userId,
    });
    await logEvent({ orgId, entityType: 'Customer', entityId: customer._id, actorUserId: auth.userId, text: `${type} uploaded for ${customer.name}` });
    await audit({ orgId, actorUserId: auth.userId, action: 'document.upload', entity: 'CustomerDocument', entityId: doc._id, meta: { type, sizeBytes: file.size } });
    return toDocument(doc.toObject<DocumentDoc>(), baseUrl);
  } catch (err) {
    await storage.remove(storageKey); // no orphan files if the database write fails
    throw err;
  }
}

export async function reviewDocument(
  auth: AuthContext, orgId: Types.ObjectId, docId: string, decision: 'VERIFY' | 'REJECT', reason: string | undefined, baseUrl: string,
) {
  const doc = await CustomerDocument.findOne({ _id: docId, orgId }).lean<DocumentDoc>();
  if (!doc) throw notFound('Document not found');
  if (doc.status === 'Verified' || doc.status === 'Rejected') {
    throw conflict(`This document is already ${doc.status.toLowerCase()}.`, 'ALREADY_REVIEWED');
  }
  if (decision === 'REJECT' && !reason) throw badRequest('Give a reason for rejecting the document.', 'REASON_REQUIRED');
  const status = decision === 'VERIFY' ? 'Verified' : 'Rejected';
  const updated = await CustomerDocument.findOneAndUpdate(
    { _id: doc._id, status: doc.status },
    { $set: { status, reviewedBy: auth.userId, reviewedAt: new Date(), rejectReason: decision === 'REJECT' ? reason : null } },
    { returnDocument: 'after' },
  ).lean<DocumentDoc>();
  if (!updated) throw conflict('This document was just reviewed by someone else.', 'ALREADY_REVIEWED');
  await logEvent({ orgId, entityType: 'Customer', entityId: doc.customerId, actorUserId: auth.userId, text: `${doc.type} ${status.toLowerCase()}` });
  await audit({ orgId, actorUserId: auth.userId, action: 'document.review', entity: 'CustomerDocument', entityId: doc._id, meta: { decision, reason } });
  return toDocument(updated, baseUrl);
}

// For the signed-link download route
export async function openDocumentFile(docId: string) {
  if (!Types.ObjectId.isValid(docId)) throw notFound('Document not found');
  const doc = await CustomerDocument.findById(docId).select('+storageKey').lean<DocumentDoc>();
  if (!doc) throw notFound('Document not found');
  return { stream: await storage.open(doc.storageKey), mimeType: doc.mimeType, sizeBytes: doc.sizeBytes };
}
