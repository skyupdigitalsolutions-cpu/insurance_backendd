import { Types } from 'mongoose';
import { badRequest, notFound } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/auth.js';
import { audit } from '../audit/audit.service.js';
import { Product, type ProductDoc } from './product.model.js';

// Shape returned to the app (Product type)
export const toProduct = (p: ProductDoc) => ({
  id: p._id.toString(),
  name: p.name,
  companyName: p.companyName,
  type: p.type,
  basePremium: p.basePremium ?? null,
  coverage: p.coverage ?? null,
  features: p.features,
  addOns: p.addOns.map((a) => ({ id: a._id.toString(), name: a.name, premium: a.premium })),
  exclusions: p.exclusions ?? null,
  eligibility: p.eligibility ?? null,
  minAge: p.minAge ?? undefined,
  maxAge: p.maxAge ?? undefined,
  source: p.source ?? null,
  version: p.version,
  active: p.active,
});

export async function productOrThrow(productId: string | Types.ObjectId, activeOnly = true): Promise<ProductDoc> {
  const p = Types.ObjectId.isValid(productId) ? await Product.findOne({ _id: productId, ...(activeOnly ? { active: true } : {}) }).lean<ProductDoc>() : null;
  if (!p) throw notFound('Product not found');
  return p;
}

export async function listProducts(type?: ProductDoc['type'], includeInactive = false) {
  const items = await Product.find({ ...(type ? { type } : {}), ...(includeInactive ? {} : { active: true }) })
    .sort({ type: 1, name: 1 }).lean<ProductDoc[]>();
  return { items: items.map(toProduct) };
}

export const getProduct = async (id: string) => toProduct(await productOrThrow(id));

export async function compareProducts(ids: string[]) {
  const unique = [...new Set(ids)];
  if (unique.length < 2 || unique.length > 3) throw badRequest('Choose 2 or 3 products to compare.', 'COMPARE_COUNT');
  const list = await Promise.all(unique.map((id) => productOrThrow(id)));
  if (new Set(list.map((p) => p.type)).size > 1) throw badRequest('Only products of the same insurance type can be compared.', 'COMPARE_TYPE');
  return { items: list.map(toProduct) };
}

// ---------- platform admin (web admin panel) ----------
export type ProductInput = {
  name: string; companyName: string; type: ProductDoc['type']; basePremium: number | null; coverage: string | null;
  features: string[]; addOns: { name: string; premium: number }[]; exclusions: string | null; eligibility: string | null;
  minAge: number | null; maxAge: number | null; source: string | null; active: boolean;
};

function checkAges(input: { minAge?: number | null; maxAge?: number | null }) {
  if (input.minAge != null && input.maxAge != null && input.minAge > input.maxAge) {
    throw badRequest('Minimum age cannot be above maximum age.', 'AGE_RANGE');
  }
}

export async function createProduct(admin: AuthContext, input: ProductInput) {
  checkAges(input);
  const p = await Product.create({ ...input, updatedBy: admin.userId });
  await audit({ actorUserId: admin.userId, action: 'product.create', entity: 'Product', entityId: p._id });
  return toProduct(p.toObject<ProductDoc>());
}

// Every change creates a new version; quotations made earlier keep their snapshot
export async function updateProduct(admin: AuthContext, productId: string, input: Partial<ProductInput>) {
  const before = await productOrThrow(productId, false);
  checkAges({ minAge: input.minAge ?? before.minAge, maxAge: input.maxAge ?? before.maxAge });
  const p = await Product.findOneAndUpdate(
    { _id: before._id, version: before.version }, // nobody else saved in between
    { $set: { ...input, updatedBy: admin.userId }, $inc: { version: 1 } },
    { returnDocument: 'after' },
  ).lean<ProductDoc>();
  if (!p) throw badRequest('This product was just changed by someone else. Reload and try again.', 'STALE_PRODUCT');
  await audit({ actorUserId: admin.userId, action: 'product.update', entity: 'Product', entityId: p._id, meta: { fromVersion: before.version, changes: Object.keys(input) } });
  return toProduct(p);
}
