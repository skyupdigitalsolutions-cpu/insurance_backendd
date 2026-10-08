// Permission codes in "resource:action" format (SRS §8.1).
// Must match src/domain/permissions.ts in the mobile app.

export const ORG_PERMISSIONS = [
  'dashboard:read',
  'lead:read', 'lead:create', 'lead:update',
  'customer:read', 'customer:create', 'customer:update',
  'product:read',
  'quotation:read', 'quotation:create', 'quotation:discount', 'quotation:approve',
  'payment:read', 'payment:create',
  'policy:read', 'policy:issue',
  'renewal:read', 'renewal:manage',
  'referral:read', 'referral:create',
  'task:read', 'communication:send',
  'report:read',
  'user:manage',
] as const;

// Used only by the company's own platform admins (web admin panel)
export const PLATFORM_PERMISSIONS = [
  'platform:registration:approve', 'platform:product:manage',
  'platform:ops:view', // overview, advisors, audit log, job status
  'platform:jobs:run', // run a background job now
] as const;

export type OrgPermission = (typeof ORG_PERMISSIONS)[number];
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];
export type Permission = OrgPermission | PlatformPermission;

export const isOrgPermission = (code: string): code is OrgPermission =>
  (ORG_PERMISSIONS as readonly string[]).includes(code);

// Default roles created for every new advisor account
export const ADVISOR_ROLE = { key: 'advisor', name: 'Advisor', permissions: [...ORG_PERMISSIONS] } as const;
export const STAFF_ROLE = {
  key: 'staff',
  name: 'Office Staff',
  permissions: [
    'dashboard:read', 'lead:read', 'lead:create', 'lead:update', 'customer:read', 'customer:create', 'customer:update',
    'product:read', 'quotation:read', 'quotation:create', 'payment:read', 'policy:read', 'renewal:read', 'task:read',
    'referral:read', 'referral:create',
  ] satisfies OrgPermission[],
} as const;
export const PLATFORM_ADMIN_ROLE = { key: 'platform_admin', name: 'Platform Admin', permissions: [...PLATFORM_PERMISSIONS] } as const;
