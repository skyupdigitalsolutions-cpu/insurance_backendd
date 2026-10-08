// Creates the first platform admin and (outside production) the demo accounts the app's Login screen mentions.
// Safe to run many times: anything that already exists is left unchanged.
//   npm run seed
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { isProduction } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { hashPassword } from '../modules/auth/auth.service.js';
import { Organization } from '../modules/orgs/organization.model.js';
import { ReferralCode } from '../modules/referrals/referralCode.model.js';
import { PLATFORM_ADMIN_ROLE } from '../modules/roles/permissions.js';
import { Role } from '../modules/roles/role.model.js';
import { createDefaultRoles } from '../modules/roles/roles.service.js';
import { User } from '../modules/users/user.model.js';
import { Product } from '../modules/products/product.model.js';
import { seedDemoBusinessData, seedDemoPart4, seedDemoProducts, seedTemplates } from './demoData.js';

export const DEMO = {
  admin: { name: 'Platform Admin', email: 'admin@insurance.local', mobile: '+919000000001' },
  advisor: { name: 'Demo Advisor', email: 'demo@test.com', mobile: '+919000000100' },
  staff: { name: 'Priya (Office Staff)', email: 'staff@test.com', mobile: '+919000000200' },
};

export async function seedDatabase(opts: { password: string; adminEmail?: string; includeDemo: boolean }): Promise<void> {
  const passwordHash = await hashPassword(opts.password);

  // 1. Platform admin (company staff who approve advisors in the web admin panel)
  const platformRole = await Role.findOneAndUpdate(
    { orgId: null, key: PLATFORM_ADMIN_ROLE.key },
    {
      $setOnInsert: { name: PLATFORM_ADMIN_ROLE.name, nameKey: PLATFORM_ADMIN_ROLE.name.toLowerCase(), system: true },
      $set: { permissions: [...PLATFORM_ADMIN_ROLE.permissions] },
    },
    { upsert: true, returnDocument: 'after' },
  );
  const adminEmail = opts.adminEmail ?? DEMO.admin.email;
  if (!(await User.exists({ email: adminEmail }))) {
    await User.create({
      orgId: null, roleId: platformRole._id, name: DEMO.admin.name, email: adminEmail, mobile: DEMO.admin.mobile,
      passwordHash, status: 'ACTIVE', isPlatformAdmin: true, mobileVerifiedAt: new Date(), approvedAt: new Date(),
    });
    logger.info({ email: adminEmail }, 'Created platform admin');
  }

  // Company-approved message templates (Part 4), also needed in production
  const addedTemplates = await seedTemplates();
  if (addedTemplates) logger.info({ added: addedTemplates }, 'Added message templates');

  // 2. Demo advisor + office staff (same accounts as the app's demo hint)
  if (!opts.includeDemo) return;
  if (!(await Product.exists({}))) {
    await seedDemoProducts(); // Part 3: demo product catalogue
    logger.info('Added the demo product catalogue');
  }
  const existingOwner = await User.findOne({ email: DEMO.advisor.email }).lean();
  if (existingOwner?.orgId) {
    // Database seeded by an earlier part: only add the demo business data if it is missing
    if (!(await ReferralCode.exists({ orgId: existingOwner.orgId }))) {
      await seedDemoBusinessData(existingOwner.orgId, existingOwner._id);
      logger.info('Added demo business data (leads, customers, tasks) to the existing demo advisor');
    }
    await seedDemoPart4(existingOwner.orgId); // subscription, invoices, policies due for renewal (once)
    return;
  }
  const org = await Organization.create({ name: 'Demo Advisor Agency', irdaiNumber: 'IRDA-DEMO-001', trialStartedAt: new Date() });
  const { advisor, staff } = await createDefaultRoles(org._id);
  const owner = await User.create({
    orgId: org._id, roleId: advisor._id, ...DEMO.advisor, passwordHash, status: 'ACTIVE',
    mobileVerifiedAt: new Date(), approvedAt: new Date(),
  });
  await User.create({ orgId: org._id, roleId: staff._id, ...DEMO.staff, passwordHash, status: 'ACTIVE' });
  await Organization.updateOne({ _id: org._id }, { $set: { ownerUserId: owner._id } });
  await seedDemoBusinessData(org._id, owner._id); // leads, customers, family, nominee, tasks (Part 2)
  await seedDemoPart4(org._id); // Pro subscription + invoices, policies due for renewal (Part 4)
  logger.info('Created demo advisor (demo@test.com), office staff (staff@test.com) and demo business data');
}

// Run only when executed directly (npm run seed), not when imported by the tests
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const seedEnv = z
    .object({
      SEED_PASSWORD: z.string().min(8, 'SEED_PASSWORD must be at least 8 characters').default(isProduction ? '' : 'Demo@1234'),
      SEED_ADMIN_EMAIL: z.email().optional(),
    })
    .parse(process.env);

  try {
    await connectMongo();
    await seedDatabase({ password: seedEnv.SEED_PASSWORD, adminEmail: seedEnv.SEED_ADMIN_EMAIL, includeDemo: !isProduction });
    logger.info('Seed complete');
  } catch (err) {
    logger.error({ err }, 'Seed failed');
    process.exitCode = 1;
  } finally {
    await disconnectMongo();
  }
}
