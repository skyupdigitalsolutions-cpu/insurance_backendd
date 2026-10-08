// Read-only views for the company's web admin panel: platform overview, advisors, audit log, background jobs.
import type { Types } from 'mongoose';
import { JOB_NAMES, JOBS, isJobName } from '../../jobs/definitions.js';
import { jobsQueue } from '../../jobs/queue.js';
import { badRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { pingMongo } from '../../lib/mongo.js';
import { pingRedis } from '../../lib/redis.js';
import { escapeRegex, maskMobile } from '../../lib/validators.js';
import type { AuthContext } from '../../middleware/auth.js';
import { AuditLog } from '../audit/audit.model.js';
import { audit } from '../audit/audit.service.js';
import { Message } from '../communications/communication.models.js';
import { Customer } from '../customers/customer.model.js';
import { Organization } from '../orgs/organization.model.js';
import { Payment } from '../payments/payment.model.js';
import { Policy } from '../policies/policy.model.js';
import { Product } from '../products/product.model.js';
import { planById } from '../subscription/plans.js';
import { featuresOf } from '../subscription/subscription.service.js';
import { Subscription } from '../subscription/subscription.model.js';
import { User } from '../users/user.model.js';

const DAY = 86_400_000;

const ownerIds = () => Organization.distinct('ownerUserId', { ownerUserId: { $ne: null } });

// Job queue health without failing the whole page when Redis is down
async function queueHealth() {
  try {
    const q = jobsQueue();
    const [workers, counts] = await Promise.all([q.getWorkersCount(), q.getJobCounts('failed', 'active', 'waiting', 'delayed')]);
    return { workersOnline: workers, failedJobs: counts.failed ?? 0, activeJobs: counts.active ?? 0 };
  } catch (err) {
    logger.warn({ err }, 'Job queue not reachable');
    return { workersOnline: 0, failedJobs: 0, activeJobs: 0 };
  }
}

export async function overview() {
  const now = new Date();
  const owners = await ownerIds();
  const [advisorStatuses, subs, productsActive, productsTotal, activePolicies, payments30, messages7, mongo, redis, jobs] = await Promise.all([
    User.aggregate<{ _id: string; n: number }>([{ $match: { _id: { $in: owners } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    // Plans of approved advisors only (pending / rejected sign-ups are not customers yet)
    User.distinct('orgId', { _id: { $in: owners }, status: 'ACTIVE' }).then((orgIds) =>
      Subscription.find({ orgId: { $in: orgIds } }).select('planId status currentPeriodEnd').lean()),
    Product.countDocuments({ active: true }),
    Product.countDocuments(),
    Policy.aggregate<{ n: number; premium: number }>([{ $match: { status: 'ACTIVE' } }, { $group: { _id: null, n: { $sum: 1 }, premium: { $sum: '$premium' } } }]),
    Payment.aggregate<{ n: number; amount: number }>([
      { $match: { status: 'SUCCESS', paidAt: { $gte: new Date(now.getTime() - 30 * DAY) } } },
      { $group: { _id: null, n: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
    Message.aggregate<{ _id: string; n: number }>([{ $match: { createdAt: { $gte: new Date(now.getTime() - 7 * DAY) } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    pingMongo(),
    pingRedis(),
    queueHealth(),
  ]);
  const byStatus = Object.fromEntries(advisorStatuses.map((s) => [s._id, s.n])) as Record<string, number>;
  const plans = { trial: 0, basic: 0, pro: 0, expired: 0 };
  for (const s of subs) {
    const graceMs = s.status === 'TRIAL' ? 0 : 3 * DAY;
    if (s.currentPeriodEnd.getTime() + graceMs < now.getTime()) plans.expired += 1;
    else plans[s.planId] += 1;
  }
  const msg = Object.fromEntries(messages7.map((m) => [m._id, m.n])) as Record<string, number>;
  return {
    advisors: {
      active: byStatus.ACTIVE ?? 0,
      pendingApproval: byStatus.PENDING_VERIFICATION ?? 0,
      rejected: byStatus.REJECTED ?? 0,
      inactive: byStatus.INACTIVE ?? 0,
    },
    plans,
    products: { active: productsActive, total: productsTotal },
    policies: { active: activePolicies[0]?.n ?? 0, premium: activePolicies[0]?.premium ?? 0 },
    payments30d: { count: payments30[0]?.n ?? 0, amount: payments30[0]?.amount ?? 0 },
    messages7d: { sent: msg.Sent ?? 0, delivered: msg.Delivered ?? 0, failed: msg.Failed ?? 0 },
    health: { api: true, mongo, redis, ...jobs },
  };
}

// Advisors (organization owners) with their plan and size
export async function listAdvisors(query: { q: string; page: number; limit: number }) {
  const owners = await ownerIds();
  const filter: Record<string, unknown> = { _id: { $in: owners } };
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), 'i');
    filter.$or = [{ name: rx }, { email: rx }, { mobile: rx }];
  }
  const [users, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    User.countDocuments(filter),
  ]);
  const orgIds = users.map((u) => u.orgId).filter((id): id is Types.ObjectId => !!id);
  const count = (model: typeof User | typeof Customer | typeof Policy, match: Record<string, unknown>) =>
    (model as typeof User).aggregate<{ _id: Types.ObjectId; n: number }>([{ $match: { orgId: { $in: orgIds }, ...match } }, { $group: { _id: '$orgId', n: { $sum: 1 } } }]);
  const [orgs, userCounts, customerCounts, policyCounts] = await Promise.all([
    Organization.find({ _id: { $in: orgIds } }).lean(),
    count(User, { status: 'ACTIVE' }),
    count(Customer, {}),
    count(Policy, { status: 'ACTIVE' }),
  ]);
  const toMap = (rows: { _id: Types.ObjectId; n: number }[]) => new Map(rows.map((r) => [r._id.toString(), r.n]));
  const [usersBy, customersBy, policiesBy] = [toMap(userCounts), toMap(customerCounts), toMap(policyCounts)];
  const orgBy = new Map(orgs.map((o) => [o._id.toString(), o]));
  const items = await Promise.all(users.map(async (u) => {
    const key = u.orgId?.toString() ?? '';
    const { plan, status } = u.orgId ? await featuresOf(u.orgId) : { plan: null, status: 'TRIAL' };
    return {
      userId: u._id.toString(),
      orgId: key,
      name: u.name,
      agency: orgBy.get(key)?.name ?? '',
      email: u.email,
      mobile: maskMobile(u.mobile),
      irdaiNumber: orgBy.get(key)?.irdaiNumber ?? null,
      status: u.status,
      plan: plan ? (planById(plan.id)?.name ?? plan.id) : '—',
      planStatus: status,
      users: usersBy.get(key) ?? 0,
      customers: customersBy.get(key) ?? 0,
      activePolicies: policiesBy.get(key) ?? 0,
      registeredAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    };
  }));
  return { items, page: query.page, limit: query.limit, total };
}

export async function listAudit(query: { action?: string | undefined; page: number; limit: number }) {
  const filter = query.action ? { action: new RegExp(`^${escapeRegex(query.action)}`) } : {};
  const [rows, total] = await Promise.all([
    AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  const actorIds = [...new Set(rows.map((r) => r.actorUserId?.toString()).filter((id): id is string => !!id))];
  const actors = await User.find({ _id: { $in: actorIds } }).select('name').lean();
  const nameOf = new Map(actors.map((a) => [a._id.toString(), a.name]));
  return {
    items: rows.map((r) => ({
      id: r._id.toString(),
      at: r.createdAt,
      action: r.action,
      entity: r.entity,
      entityId: r.entityId?.toString() ?? null,
      actor: r.actorUserId ? (nameOf.get(r.actorUserId.toString()) ?? 'Unknown user') : 'System',
      orgId: r.orgId?.toString() ?? null,
      ip: r.ip ?? null,
      meta: (r.meta ?? null) as unknown,
    })),
    page: query.page,
    limit: query.limit,
    total,
  };
}

// Schedule, next run, last result and failures of every job
export async function listJobs() {
  const q = jobsQueue();
  const [schedulers, recent, workers] = await Promise.all([
    q.getJobSchedulers(),
    q.getJobs(['completed', 'failed', 'active'], 0, 300),
    q.getWorkersCount(),
  ]);
  const nextOf = new Map(schedulers.map((s) => [s.key, s.next ?? null]));
  const items = JOB_NAMES.map((name) => {
    const runs = recent.filter((j) => j.name === name).sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const last = runs.find((j) => j.finishedOn) ?? null;
    const failed = last?.failedReason ? true : false;
    return {
      name,
      label: JOBS[name].label,
      description: JOBS[name].description,
      schedule: JOBS[name].schedule,
      nextRunAt: nextOf.get(name) ? new Date(nextOf.get(name)!) : null,
      running: runs.some((j) => !j.finishedOn && j.processedOn),
      lastRun: last ? {
        jobId: last.id ?? null,
        finishedAt: new Date(last.finishedOn!),
        status: failed ? 'failed' : 'completed',
        result: failed ? null : (last.returnvalue as unknown),
        error: last.failedReason ?? null,
        attempts: last.attemptsMade,
        manual: (last.data as { manual?: boolean } | undefined)?.manual === true,
      } : null,
      recentFailures: runs.filter((j) => j.failedReason).length,
    };
  });
  return { workersOnline: workers, items };
}

export async function runJobNow(auth: AuthContext, name: string) {
  if (!isJobName(name)) throw badRequest('Unknown job', 'UNKNOWN_JOB');
  const job = await jobsQueue().add(name, { manual: true, by: auth.userId.toString() });
  await audit({ orgId: null, actorUserId: auth.userId, action: 'job.run', entity: 'Job', meta: { name, jobId: job.id } });
  return { jobId: job.id ?? null, name, queuedAt: new Date() };
}
