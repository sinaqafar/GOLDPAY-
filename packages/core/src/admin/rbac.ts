/**
 * Role-based access control for platform administration.
 *
 * SPEC 117: SUPER_ADMIN, FINANCE_ADMIN, OPERATIONS_ADMIN, SUPPORT_AGENT,
 * RISK_AGENT, DEVELOPER_SUPPORT, READ_ONLY.
 *
 * Design notes:
 *  - Permissions are granted explicitly. There is no wildcard and no implicit
 *    inheritance, so reading this file tells you exactly who can do what.
 *  - Even SUPER_ADMIN is enumerated: an accidental new permission is denied to
 *    everyone until a human adds it here on purpose.
 */

import { SecurityError } from '../../../errors/src/index.ts';

export const ADMIN_ROLES = [
  'SUPER_ADMIN',
  'FINANCE_ADMIN',
  'OPERATIONS_ADMIN',
  'SUPPORT_AGENT',
  'RISK_AGENT',
  'DEVELOPER_SUPPORT',
  'READ_ONLY',
] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

export const PERMISSIONS = [
  // read
  'merchants:read',
  'payments:read',
  'payouts:read',
  'treasury:read',
  'ledger:read',
  'audit:read',
  'exceptions:read',
  // write
  'merchants:suspend',
  'merchants:activate',
  'payouts:retry',
  'exceptions:resolve',
  // dangerous — money moves or the platform stops
  'treasury:fund',
  'treasury:approve',
  'platform:freeze',
  'platform:unfreeze',
  'admins:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const READ_ALL: Permission[] = [
  'merchants:read',
  'payments:read',
  'payouts:read',
  'treasury:read',
  'ledger:read',
  'audit:read',
  'exceptions:read',
];

/**
 * The authorisation matrix. Anything not listed is denied.
 *
 * Note that no single role can both request and approve treasury funding:
 * FINANCE_ADMIN requests, SUPER_ADMIN approves. That separation is what makes
 * the four-eyes rule real rather than decorative.
 */
export const ROLE_PERMISSIONS: Record<AdminRole, readonly Permission[]> = {
  SUPER_ADMIN: [
    ...READ_ALL,
    'merchants:suspend',
    'merchants:activate',
    'payouts:retry',
    'exceptions:resolve',
    'treasury:approve',
    'platform:freeze',
    'platform:unfreeze',
    'admins:manage',
  ],
  FINANCE_ADMIN: [
    ...READ_ALL,
    'treasury:fund',
    'exceptions:resolve',
    'payouts:retry',
    'platform:freeze',
  ],
  OPERATIONS_ADMIN: [
    ...READ_ALL,
    'merchants:suspend',
    'merchants:activate',
    'payouts:retry',
    'exceptions:resolve',
  ],
  SUPPORT_AGENT: ['merchants:read', 'payments:read', 'payouts:read', 'exceptions:read'],
  RISK_AGENT: [...READ_ALL, 'merchants:suspend', 'platform:freeze'],
  DEVELOPER_SUPPORT: ['merchants:read', 'payments:read', 'payouts:read', 'exceptions:read'],
  READ_ONLY: [...READ_ALL],
};

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === 'string' && (ADMIN_ROLES as readonly string[]).includes(value);
}

export function hasPermission(role: AdminRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/**
 * Throw unless the role holds the permission.
 *
 * The error deliberately names the missing permission: an admin being told
 * precisely what they lack is useful, and it reveals nothing an attacker could
 * not learn from this file.
 */
export function assertPermission(role: AdminRole, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    // SecurityError maps to 403: the caller is authenticated, just not allowed.
    throw new SecurityError('FORBIDDEN', `role ${role} lacks the ${permission} permission`, {
      role,
      permission,
    });
  }
}

/** Operations that require a second, different admin to approve. */
export const FOUR_EYES_OPERATIONS = ['TREASURY_FUNDING'] as const;
export type FourEyesOperation = (typeof FOUR_EYES_OPERATIONS)[number];
