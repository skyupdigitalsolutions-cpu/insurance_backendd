import { z } from 'zod';
import { defineRoute } from '../../lib/route.js';
import { idParams, objectId } from '../../lib/validators.js';
import { INSURANCE_TYPES } from '../customers/related.models.js';
import { compareProducts, createProduct, getProduct, listProducts, updateProduct } from './products.service.js';

const nullableText = (max: number) => z.string().trim().max(max).nullable().transform((v) => (v ? v : null));
const productInput = z.object({
  name: z.string().trim().min(2).max(120),
  companyName: z.string().trim().min(2).max(120),
  type: z.enum(INSURANCE_TYPES),
  basePremium: z.number().int().min(0).max(100_000_000).nullable(),
  coverage: nullableText(300),
  features: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  addOns: z.array(z.object({ name: z.string().trim().min(1).max(120), premium: z.number().int().min(0).max(10_000_000) })).max(20).default([]),
  exclusions: nullableText(1000),
  eligibility: nullableText(300),
  minAge: z.number().int().min(0).max(120).nullable(),
  maxAge: z.number().int().min(0).max(120).nullable(),
  source: nullableText(300),
  active: z.boolean().default(true),
});

export const productRoutes = [
  defineRoute({
    method: 'get', path: '/products', tag: 'Products', summary: 'Active products (optionally one insurance type)',
    access: 'user', permission: 'product:read', query: z.object({ insuranceType: z.enum(INSURANCE_TYPES).optional() }),
    handler: ({ query }) => listProducts(query.insuranceType),
  }),
  defineRoute({
    method: 'get', path: '/products/:id', tag: 'Products', summary: 'One product',
    access: 'user', permission: 'product:read', params: idParams,
    handler: ({ params }) => getProduct(params.id),
  }),
  defineRoute({
    method: 'post', path: '/comparisons', tag: 'Products', summary: 'Compare 2–3 products of the same type',
    access: 'user', permission: 'product:read', body: z.object({ productIds: z.array(objectId).min(1).max(5) }),
    handler: ({ body }) => compareProducts(body.productIds),
  }),

  // ---- platform admin (web admin panel) ----
  defineRoute({
    method: 'get', path: '/admin/products', tag: 'Admin', summary: 'All products including inactive',
    access: 'user', permission: 'platform:product:manage', query: z.object({ insuranceType: z.enum(INSURANCE_TYPES).optional() }),
    handler: ({ query }) => listProducts(query.insuranceType, true),
  }),
  defineRoute({
    method: 'post', path: '/admin/products', tag: 'Admin', summary: 'Add a product to the catalogue',
    access: 'user', permission: 'platform:product:manage', body: productInput, status: 201,
    handler: ({ auth, body }) => createProduct(auth, body),
  }),
  defineRoute({
    method: 'patch', path: '/admin/products/:id', tag: 'Admin', summary: 'Change a product (creates a new version)',
    access: 'user', permission: 'platform:product:manage', params: idParams, body: productInput.partial(),
    handler: ({ auth, params, body }) => updateProduct(auth, params.id, body),
  }),
];
