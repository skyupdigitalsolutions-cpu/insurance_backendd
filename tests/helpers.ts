import mongoose from 'mongoose';
import request from 'supertest';
import { expect } from 'vitest';
import { createApp } from '../src/app.js';
import { Customer } from '../src/modules/customers/customer.model.js';
import { Policy } from '../src/modules/policies/policy.model.js';
import { Product } from '../src/modules/products/product.model.js';
import { Subscription } from '../src/modules/subscription/subscription.model.js';
import { User } from '../src/modules/users/user.model.js';
import { connectMongo, disconnectMongo } from '../src/lib/mongo.js';
import { connectRedis, disconnectRedis, redis } from '../src/lib/redis.js';
import { closeJobsQueue } from '../src/jobs/queue.js';
import { DEMO, seedDatabase } from '../src/scripts/seed.js';

export const PASSWORD = 'Demo@1234';
export const OTP = '123456'; // OTP_FIXED_CODE in vitest.config.ts
export { DEMO };

export const app = createApp({ rateLimit: false });
export const api = () => request(app);
export const V1 = '/api/v1';

// Fresh database + demo data before each test file
export async function resetDatabase(): Promise<void> {
  await connectMongo();
  await mongoose.connection.dropDatabase();
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).createIndexes()));
  await connectRedis();
  await redis.flushdb();
  await seedDatabase({ password: PASSWORD, includeDemo: true });
}

export async function closeConnections(): Promise<void> {
  await closeJobsQueue();
  await disconnectMongo();
  await disconnectRedis();
}

export type Tokens = { accessToken: string; refreshToken: string; mustChangePassword: boolean };

export async function loginAs(identifier: string, password = PASSWORD): Promise<Tokens> {
  const res = await api().post(`${V1}/auth/login`).send({ identifier, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Tokens;
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

let counter = 0;
// A new, unique advisor sign-up
export function newAdvisor(overrides: Partial<Record<'name' | 'email' | 'mobile' | 'password' | 'irdaiNumber', string>> = {}) {
  counter += 1;
  const n = String(counter).padStart(4, '0');
  return {
    name: `Test Advisor ${n}`,
    email: `advisor${n}@example.com`,
    mobile: `+91987654${n}`,
    password: 'Secret123',
    irdaiNumber: `IRDA-${n}`,
    ...overrides,
  };
}

export type Challenge = { challengeId: string; userId: string; maskedMobile: string; resendAfterSec: number };

// register → verify OTP → (optionally) admin approves. Returns the userId and the sign-up data.
export async function registerAdvisor(opts: { verify?: boolean; approve?: boolean } = {}) {
  const input = newAdvisor();
  const reg = await api().post(`${V1}/auth/register`).send(input);
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const challenge = reg.body as Challenge;
  if (opts.verify || opts.approve) {
    const v = await api().post(`${V1}/auth/otp/verify`).send({ challengeId: challenge.challengeId, code: OTP });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
  }
  if (opts.approve) {
    const admin = await loginAs(DEMO.admin.email);
    const a = await api().post(`${V1}/admin/registrations/${challenge.userId}/approve`).set(bearer(admin.accessToken));
    expect(a.status, JSON.stringify(a.body)).toBe(200);
  }
  return { input, challenge };
}

// ---------- Part 2 helpers ----------
export async function tokenOf(email: string, password = PASSWORD): Promise<string> {
  return (await loginAs(email, password)).accessToken;
}

let mobileCounter = 0;
// A fresh valid Indian mobile number for test leads/customers
export function freshMobile(): string {
  mobileCounter += 1;
  return `+9170000${String(mobileCounter).padStart(5, '0')}`;
}

// Smallest valid file headers, enough for type detection
export const FILES = {
  jpg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]),
  png: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 2)]),
  pdf: Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n'),
  exe: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 3)]), // a Windows program pretending to be a photo
};

// ---------- Part 3 helpers ----------

export const productId = async (name: string) => (await Product.findOne({ name }).lean())!._id.toString();
export const addOnId = async (productName: string, addOnName: string) =>
  (await Product.findOne({ name: productName }).lean())!.addOns.find((a) => a.name === addOnName)!._id.toString();
export const customerId = async (name: string) => (await Customer.findOne({ name }).lean())!._id.toString();

// Path + query of an absolute link (supertest calls the app directly)
export const pathOf = (url: string) => { const u = new URL(url); return u.pathname + u.search; };

// ---------- Part 4 helpers ----------

export const policyIdOf = async (policyNumber: string) => (await Policy.findOne({ policyNumber }).lean())!._id.toString();
export const demoOrgId = async () => (await User.findOne({ email: DEMO.advisor.email }).lean())!.orgId!;

// Puts the demo advisor on a plan (for plan / feature tests)
export async function setDemoPlan(planId: 'trial' | 'basic' | 'pro', opts: { expired?: boolean } = {}) {
  const end = new Date(Date.now() + (opts.expired ? -10 : 20) * 86_400_000);
  await Subscription.updateOne(
    { orgId: await demoOrgId() },
    { $set: { planId, status: planId === 'trial' ? 'TRIAL' : 'ACTIVE', cycle: 'monthly', currentPeriodEnd: end } },
    { upsert: true },
  );
}
