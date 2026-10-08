import type { Types } from 'mongoose';
import { badRequest, conflict } from '../../lib/errors.js';
import type { AuthContext } from '../../middleware/auth.js';
import { isDuplicateKeyError } from '../../middleware/error.js';
import { logEvent } from '../activities/activities.service.js';
import { audit } from '../audit/audit.service.js';
import { customerOrThrow } from '../customers/customers.service.js';
import { Lead, type LeadDoc } from '../leads/lead.model.js';
import { Referral, type ReferralDoc } from './referral.model.js';
import { ReferralCode } from './referralCode.model.js';

const statusOf = (lead: Pick<LeadDoc, 'status' | 'customerId'> | undefined) =>
  lead?.status === 'LOST' ? 'Rejected' : lead?.customerId || lead?.status === 'CONVERTED' ? 'Converted' : 'Assigned';

export async function listReferrals(orgId: Types.ObjectId) {
  const refs = await Referral.find({ orgId }).sort({ createdAt: -1, _id: -1 }).limit(300).lean<ReferralDoc[]>();
  const leads = await Lead.find({ _id: { $in: refs.map((r) => r.leadId) } }).select('status customerId').lean<LeadDoc[]>();
  const leadById = new Map(leads.map((l) => [l._id.toString(), l]));
  return {
    items: refs.map((r) => ({
      id: r._id.toString(), referrerName: r.referrerName, code: r.code ?? undefined, name: r.name, mobile: r.mobile,
      relationship: r.relationship, interest: r.interest, leadId: r.leadId.toString(),
      status: statusOf(leadById.get(r.leadId.toString())), createdAt: r.createdAt,
    })),
  };
}

export type NewReferral = {
  referrerCustomerId?: string | undefined; code?: string | undefined; name: string; mobile: string; relationship: string; interest: string;
};

// Referral → new lead with the referral source locked on it
export async function createReferral(auth: AuthContext, orgId: Types.ObjectId, input: NewReferral) {
  let referrerName: string;
  let referrerCustomerId: Types.ObjectId | null;
  const code = input.code?.toUpperCase();
  if (code) {
    const rc = await ReferralCode.findOne({ orgId, code, active: true }).lean();
    if (!rc) throw badRequest('Referral code is not active.', 'REFERRAL_CODE_INACTIVE');
    referrerName = `Code ${code}`;
    referrerCustomerId = rc.ownerCustomerId ?? null;
  } else if (input.referrerCustomerId) {
    const c = await customerOrThrow(orgId, input.referrerCustomerId);
    referrerName = c.name;
    referrerCustomerId = c._id;
  } else {
    throw badRequest('Choose the referring customer or enter a referral code.', 'REFERRER_REQUIRED');
  }

  let lead;
  try {
    lead = await Lead.create({
      orgId, name: input.name, mobile: input.mobile, source: 'Referral', referralCode: code ?? null,
      requirement: `${input.interest} insurance`, notes: `Referred by ${referrerName} (${input.relationship})`, createdBy: auth.userId,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw conflict('A lead with this mobile number already exists.', 'DUPLICATE_LEAD');
    throw err;
  }
  let ref;
  try {
    ref = await Referral.create({
      orgId, referrerCustomerId, referrerName, code: code ?? null, name: input.name, mobile: input.mobile,
      relationship: input.relationship, interest: input.interest, leadId: lead._id, createdBy: auth.userId,
    });
  } catch (err) {
    await Lead.deleteOne({ _id: lead._id }); // no lead without its referral record
    throw err;
  }
  await logEvent({ orgId, entityType: 'Lead', entityId: lead._id, actorUserId: auth.userId, text: `New referral: ${input.name} (by ${referrerName})` });
  await audit({ orgId, actorUserId: auth.userId, action: 'referral.create', entity: 'Referral', entityId: ref._id });
  return {
    id: ref._id.toString(), referrerName, code: code ?? undefined, name: ref.name, mobile: ref.mobile, relationship: ref.relationship,
    interest: ref.interest, leadId: lead._id.toString(), status: 'Assigned' as const, createdAt: ref.createdAt,
  };
}
