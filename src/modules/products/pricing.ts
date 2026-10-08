// Pricing rules. Only the server calculates prices; the app only shows them.
//   FINAL PAYABLE = BASE + VALID ADD-ONS − AUTHORISED DISCOUNT, then GST
import { badRequest } from '../../lib/errors.js';
import type { ProductDoc } from './product.model.js';

export const ADVISOR_DISCOUNT_LIMIT = 10; // % an advisor may give without approval
export const MAX_DISCOUNT = 25;           // % never allowed above this
export const MONTHLY_LOADING = 1.04;      // monthly instalments cost 4 % more per year

// GST on the premium, by insurance type.
// Since 22 Sep 2025 individual life and health insurance premiums are GST-exempt in India; motor insurance is 18 %.
// Have the company's accountant confirm these rates before go-live and whenever GST rules change.
export const GST_RATES: Record<ProductDoc['type'], number> = { Health: 0, Life: 0, Motor: 0.18 };

export type Pricing = { base: number; addOns: number; subtotal: number; discount: number; gst: number; total: number };
export type PricingInput = { addOnIds: string[]; frequency: 'Yearly' | 'Monthly'; discountPercent: number };

export function calculatePricing(product: ProductDoc, input: PricingInput) {
  if (product.basePremium === null || product.basePremium === undefined) throw badRequest('This product has no published price. Choose another product.', 'NO_PRICE');
  if (input.discountPercent < 0 || input.discountPercent > MAX_DISCOUNT) {
    throw badRequest(`Discount must be between 0% and ${MAX_DISCOUNT}%.`, 'DISCOUNT_RANGE');
  }
  const selected = product.addOns.filter((a) => input.addOnIds.includes(a._id.toString()));
  if (selected.length !== new Set(input.addOnIds).size) throw badRequest('One of the add-ons does not belong to this product.', 'INVALID_ADDON');

  const base = product.basePremium;
  const addOns = selected.reduce((s, a) => s + a.premium, 0);
  const subtotal = base + addOns;
  const discount = Math.round((subtotal * input.discountPercent) / 100);
  const gst = Math.round((subtotal - discount) * GST_RATES[product.type]);
  let total = subtotal - discount + gst;
  if (input.frequency === 'Monthly') total = Math.round((total * MONTHLY_LOADING) / 12); // one monthly instalment

  const pricing: Pricing = { base, addOns, subtotal, discount, gst, total };
  return { pricing, selectedAddOns: selected, needsApproval: input.discountPercent > ADVISOR_DISCOUNT_LIMIT };
}
