import { SetMetadata } from "@nestjs/common";

/**
 * The permission catalogue (TR-SEC-04). The database holds the same keys (migrations seed
 * `permissions` and `role_permissions`); a test fails if the two lists ever differ.
 */
export const PERMISSIONS = [
  "workers.read",
  "workers.create",
  "documents.create",
  "documents.verify",
  "leave.create",
  "compliance.check",
  "compliance.renewals",
  "overrides.create",
  "dashboard.read",
  "sites.read",
  "sites.create",
  "audit.read",
  "audit.verify",
  "users.manage",
  "sponsors.read",
  "sponsors.manage",
  "supply.manage",
  "supply.approve",
  "outsourcing.policy",
  "overrides.approve_unauthorised",
  "masters.read",
  "org_documents.manage",
  "clients.read",
  "clients.manage",
  "pii.view",
] as const;
export type PermissionKey = (typeof PERMISSIONS)[number];

export const ROLE_KEYS = ["owner", "ops_manager", "hr_pro", "payroll", "finance", "supervisor", "client", "worker", "admin"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

/**
 * Every route declares exactly one of these; the guard refuses any route that declares none (default deny).
 *  - public: no sign-in (sign-in itself, refresh, logout, health)
 *  - signed-in: any signed-in user, even before the first password change or 2FA set-up (me, change password, 2FA)
 *  - permission: a signed-in user who has finished set-up and holds the permission in the request's entity
 */
export type Access = { kind: "public" } | { kind: "signed-in" } | { kind: "permission"; key: PermissionKey };

export const ACCESS = "mms:access";
export const Public = () => SetMetadata(ACCESS, { kind: "public" } satisfies Access);
export const SignedIn = () => SetMetadata(ACCESS, { kind: "signed-in" } satisfies Access);
export const RequirePermission = (key: PermissionKey) => SetMetadata(ACCESS, { kind: "permission", key } satisfies Access);
