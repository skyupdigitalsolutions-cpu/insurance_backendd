import type { Types } from 'mongoose';
import { badRequest } from '../../lib/errors.js';
import { customerOrThrow } from '../customers/customers.service.js';
import { NeedAnalysis } from '../customers/related.models.js';
import { Product, type ProductDoc } from '../products/product.model.js';
import { toProduct } from '../products/products.service.js';

const ageOf = (dob?: string | null) => {
  if (!dob) return undefined;
  const d = new Date(`${dob}T00:00:00Z`);
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age;
};
const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

// Step 1: hard eligibility filter (type, age). Step 2: rank. Step 3: explain.
// Every reason comes from stored product data — nothing is invented; missing data becomes a warning.
export async function recommend(orgId: Types.ObjectId, customerId: string) {
  const customer = await customerOrThrow(orgId, customerId);
  const need = await NeedAnalysis.findOne({ orgId, customerId: customer._id }).lean();
  if (!need) throw badRequest('Save the need analysis first.', 'NEED_ANALYSIS_REQUIRED');
  const age = ageOf(customer.dob);

  const products = await Product.find({ type: need.insuranceType, active: true }).lean<ProductDoc[]>();
  const items = products
    .filter((p) => age === undefined || ((p.minAge ?? 0) <= age && age <= (p.maxAge ?? 200)))
    .map((p) => {
      const reasons: string[] = [];
      const warnings: string[] = [];
      if (p.basePremium != null && need.budget) {
        if (p.basePremium <= need.budget) reasons.push(`Premium fits the budget of ${inr(need.budget)}`);
        else warnings.push('Premium is above the stated budget');
      }
      if (p.basePremium == null) warnings.push('Premium not available – confirm with insurer');
      if (p.eligibility == null) warnings.push('Eligibility not available');
      if (age !== undefined && p.minAge != null) reasons.push(`Customer age ${age} is within ${p.eligibility ?? `${p.minAge}–${p.maxAge ?? ''}`}`);
      if (p.features[0]) reasons.push(`Key feature: ${p.features[0]}`);
      if (p.source == null) warnings.push('No source document recorded for this product');
      return { product: toProduct(p), reasons, warnings };
    })
    .sort((a, b) => b.reasons.length - a.reasons.length || a.warnings.length - b.warnings.length);
  return { items };
}
