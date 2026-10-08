import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';
import { z } from 'zod';
import { orgIdOf } from '../../middleware/auth.js';
import { defineRoute } from '../../lib/route.js';
import { idParams, objectId, optionalText } from '../../lib/validators.js';
import { DOCUMENT_TYPES } from './document.model.js';
import { checkFileSignature, listDocuments, openDocumentFile, reviewDocument, uploadDocument } from './documents.service.js';

// Absolute base URL for signed links (behind a proxy this needs TRUST_PROXY=1 for https)
const baseUrlOf = (req: Request) => `${req.protocol}://${req.get('host') ?? 'localhost'}`;

export const documentRoutes = [
  defineRoute({
    method: 'get', path: '/customers/:id/documents', tag: 'Documents', summary: 'Customer documents (each with a 15-minute view link)',
    access: 'user', permission: 'customer:read', params: idParams,
    handler: ({ auth, params, req }) => listDocuments(orgIdOf(auth), params.id, baseUrlOf(req)),
  }),
  defineRoute({
    method: 'post', path: '/customers/:id/documents', tag: 'Documents', summary: 'Upload a document (JPG/PNG/PDF, multipart field "file")',
    description: 'The customer must have given consent first. The file type is checked from its content.',
    access: 'user', permission: 'customer:update', params: idParams, fileField: 'file', status: 201,
    body: z.object({ type: z.enum(DOCUMENT_TYPES, { message: 'Choose a document type' }) }),
    handler: ({ auth, params, body, file, req }) => uploadDocument(auth, orgIdOf(auth), params.id, body.type, file, baseUrlOf(req)),
  }),
  defineRoute({
    method: 'post', path: '/documents/:id/review', tag: 'Documents', summary: 'Verify or reject a document',
    access: 'user', permission: 'customer:update', params: idParams,
    body: z.object({ decision: z.enum(['VERIFY', 'REJECT']), reason: optionalText(300) }),
    handler: ({ auth, params, body, req }) => reviewDocument(auth, orgIdOf(auth), params.id, body.decision, body.reason, baseUrlOf(req)),
  }),
  defineRoute({
    method: 'get', path: '/files/:id', tag: 'Documents', summary: 'Open a document through a signed link',
    access: 'public', limiter: 'publicRead', params: z.object({ id: objectId }),
    query: z.object({ expires: z.coerce.number().int(), sig: z.string().max(64) }),
    handler: async ({ params, query, res }) => {
      checkFileSignature(params.id, query.expires, query.sig);
      const file = await openDocumentFile(params.id);
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Length', String(file.sizeBytes));
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // the web admin panel may show it in an <img>
      await pipeline(file.stream, res);
    },
  }),
];
