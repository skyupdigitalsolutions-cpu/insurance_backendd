// Every API route, grouped by module. Later parts add their modules here.
import type { RouteDef } from './lib/route.js';
import { activityRoutes } from './modules/activities/activities.routes.js';
import { aiRoutes } from './modules/ai/ai.routes.js';
import { autodialRoutes } from './modules/autodial/autodial.routes.js';
import { communicationRoutes } from './modules/communications/communications.routes.js';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes.js';
import { enquiryRoutes } from './modules/enquiries/enquiries.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { customerRoutes } from './modules/customers/customers.routes.js';
import { documentRoutes } from './modules/documents/documents.routes.js';
import { leadRoutes } from './modules/leads/leads.routes.js';
import { paymentRoutes } from './modules/payments/payments.routes.js';
import { policyRoutes } from './modules/policies/policies.routes.js';
import { productRoutes } from './modules/products/products.routes.js';
import { quotationRoutes } from './modules/quotations/quotations.routes.js';
import { referralRoutes } from './modules/referrals/referrals.routes.js';
import { renewalRoutes } from './modules/renewals/renewals.routes.js';
import { subscriptionRoutes } from './modules/subscription/subscription.routes.js';
import { roleRoutes } from './modules/roles/roles.routes.js';
import { taskRoutes } from './modules/tasks/tasks.routes.js';
import { userRoutes } from './modules/users/users.routes.js';

export const API_BASE = '/api/v1';

export const allRoutes: RouteDef[] = [
  // Part 1
  ...authRoutes, ...userRoutes, ...roleRoutes, ...adminRoutes,
  // Part 2
  ...leadRoutes, ...customerRoutes, ...documentRoutes, ...taskRoutes, ...activityRoutes,
  // Part 3
  ...productRoutes, ...quotationRoutes, ...paymentRoutes, ...policyRoutes,
  // Part 4
  ...renewalRoutes, ...referralRoutes, ...communicationRoutes, ...dashboardRoutes, ...subscriptionRoutes, ...autodialRoutes, ...aiRoutes,
  // Website (contact form)
  ...enquiryRoutes,
];
