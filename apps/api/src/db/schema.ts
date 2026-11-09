import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Spec §3 data model — first slice: workforce, documents, sites, overrides,
 * leave and the hash-chained audit log. Every table carries entity_id so a
 * second legal entity (e.g. UAE) is configuration, not a rewrite.
 */

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

// Inside a signed-in request the row belongs to that request's entity (set by the request scope),
// which is also what the row-level security policy checks. Unscoped scripts (seed) fall back to OM-01.
// nullif: a pooled connection that once held the setting reports '' afterwards, not NULL.
const entityId = text("entity_id")
  .notNull()
  .default(sql`coalesce(nullif(current_setting('app.entity_id', true), ''), 'OM-01')`);

export const workers = pgTable(
  "workers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId,
    // Default set by migration 0001 (worker_code_seq): W-000001, W-000002, ...
    code: text("code")
      .notNull()
      .default(sql`'W-' || lpad(nextval('worker_code_seq')::text, 6, '0')`),
    fullName: text("full_name").notNull(),
    fullNameAr: text("full_name_ar"),
    nationality: text("nationality").notNull(),
    trade: text("trade").notNull(),
    status: text("status").notNull().default("available"),
    phone: text("phone"),
    dateOfBirth: date("date_of_birth", { mode: "string" }),
    joinedOn: date("joined_on", { mode: "string" }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("workers_code_uq").on(t.entityId, t.code),
    index("workers_name_idx").on(t.fullName),
    check(
      "workers_status_ck",
      sql`${t.status} in ('in_recruitment','available','deployed','on_leave','absconding_reported','exited')`,
    ),
  ],
);

export const workerDocuments = pgTable(
  "worker_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId,
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id),
    type: text("type").notNull(),
    number: text("number"),
    issueDate: date("issue_date", { mode: "string" }),
    expiryDate: date("expiry_date", { mode: "string" }),
    verified: boolean("verified").notNull().default(false),
    verifiedBy: text("verified_by"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("worker_documents_worker_idx").on(t.workerId),
    index("worker_documents_expiry_idx").on(t.expiryDate),
    check(
      "worker_documents_type_ck",
      sql`${t.type} in ('passport','residence_visa','labour_card','civil_id','medical','driving_licence','trade_certificate','insurance')`,
    ),
    check("worker_documents_dates_ck", sql`${t.issueDate} is null or ${t.expiryDate} is null or ${t.issueDate} <= ${t.expiryDate}`),
  ],
);

export const sites = pgTable(
  "sites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    entityId,
    code: text("code").notNull(),
    name: text("name").notNull(),
    clientName: text("client_name").notNull(),
    requiredDocuments: text("required_documents").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (t) => [uniqueIndex("sites_code_uq").on(t.entityId, t.code)],
);

export const complianceOverrides = pgTable("compliance_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityId,
  workerId: uuid("worker_id")
    .notNull()
    .references(() => workers.id),
  code: text("code").notNull(),
  documentType: text("document_type"),
  validUntil: date("valid_until", { mode: "string" }).notNull(),
  approvedBy: text("approved_by").notNull(),
  reason: text("reason").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const leavePeriods = pgTable("leave_periods", {
  id: uuid("id").primaryKey().defaultRandom(),
  entityId,
  workerId: uuid("worker_id")
    .notNull()
    .references(() => workers.id),
  fromDate: date("from_date", { mode: "string" }).notNull(),
  toDate: date("to_date", { mode: "string" }).notNull(),
  status: text("status").notNull().default("approved"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only, hash-chained audit trail (Spec §6). */
export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  entityId,
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  subjectType: text("subject_type").notNull(),
  subjectId: text("subject_id").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
  /** 1: entity not in the hash (rows before 2026-11-09); 2: entity hashed. */
  hashVersion: integer("hash_version").notNull().default(1),
});

// ---------------------------------------------------------------------------------------------
// Identity and access (A25, TR-SEC-01 to 07, 11). Platform tables: no entity_id on users (a
// person may hold roles in several entities); the entity lives on user_roles.
// ---------------------------------------------------------------------------------------------

const moment = (name: string) => timestamp(name, { withTimezone: true });
const uuidV7 = () => uuid("id").primaryKey().$defaultFn(() => Bun.randomUUIDv7());

export const users = pgTable(
  "users",
  {
    id: uuidV7(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    passwordHash: text("password_hash").notNull(),
    isPasswordChangeRequired: boolean("is_password_change_required").notNull().default(true),
    passwordChangedAt: moment("password_changed_at"),
    status: text("status").notNull().default("active"),
    failedSignIns: integer("failed_sign_ins").notNull().default(0),
    lockedUntil: moment("locked_until"),
    totpSecretSealed: text("totp_secret_sealed"),
    totpPendingSealed: text("totp_pending_sealed"),
    totpLastStep: bigint("totp_last_step", { mode: "number" }),
    lastSignInAt: moment("last_sign_in_at"),
    ...timestamps,
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    uniqueIndex("users_username_uq").on(sql`lower(${t.username})`),
    check("users_status_ck", sql`${t.status} in ('active','disabled')`),
    check("users_username_ck", sql`${t.username} ~ '^[a-z0-9][a-z0-9._-]{2,49}$'`),
    check("users_failed_sign_ins_ck", sql`${t.failedSignIns} >= 0`),
  ],
);

export const roles = pgTable("roles", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
});

export const permissions = pgTable("permissions", {
  key: text("key").primaryKey(),
  description: text("description").notNull(),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleKey: text("role_key").notNull().references(() => roles.key, { onDelete: "restrict" }),
    permissionKey: text("permission_key").notNull().references(() => permissions.key, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.roleKey, t.permissionKey] })],
);

export const userRoles = pgTable(
  "user_roles",
  {
    id: uuidV7(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    roleKey: text("role_key").notNull().references(() => roles.key, { onDelete: "restrict" }),
    entityId: text("entity_id").notNull(),
    siteId: uuid("site_id"),
    clientId: uuid("client_id"),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }),
    createdAt: moment("created_at").notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
    // A role ended the same day it started cannot be date-ended (valid_to >= valid_from), so it is revoked.
    revokedAt: moment("revoked_at"),
    revokedBy: text("revoked_by"),
  },
  (t) => [
    index("user_roles_user_idx").on(t.userId),
    check("user_roles_dates_ck", sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    refreshHash: text("refresh_hash").notNull(),
    previousRefreshHash: text("previous_refresh_hash"),
    previousValidUntil: moment("previous_valid_until"),
    createdAt: moment("created_at").notNull(),
    lastSeenAt: moment("last_seen_at").notNull(),
    expiresAt: moment("expires_at").notNull(),
    revokedAt: moment("revoked_at"),
    revokeReason: text("revoke_reason"),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (t) => [index("user_sessions_user_idx").on(t.userId)],
);

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    username: text("username").notNull(),
    userId: uuid("user_id"),
    ip: text("ip"),
    isSuccess: boolean("is_success").notNull(),
    reason: text("reason").notNull(),
    at: moment("at").notNull(),
  },
  (t) => [index("login_attempts_ip_idx").on(t.ip, t.at), index("login_attempts_username_idx").on(t.username, t.at)],
);

export const passwordHistory = pgTable(
  "password_history",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "restrict" }),
    passwordHash: text("password_hash").notNull(),
    createdAt: moment("created_at").notNull(),
  },
  (t) => [index("password_history_user_idx").on(t.userId, t.createdAt)],
);

// ---------------------------------------------------------------------------------------------
// Sponsors and outsourced workers (PRD 4.18, A21–A24). Business tables: entity-scoped by RLS.
// ---------------------------------------------------------------------------------------------

/** Ledger counterparties the company pays (Backend Schema "suppliers"); started here for labour payees. */
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuidV7(),
    entityId,
    name: text("name").notNull(),
    vatNumber: text("vat_number"),
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),
    ...timestamps,
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [check("suppliers_terms_ck", sql`${t.paymentTermsDays} between 0 and 365`)],
);

export const sponsors = pgTable(
  "sponsors",
  {
    id: uuidV7(),
    entityId,
    kind: text("kind").notNull(),
    legalName: text("legal_name").notNull(),
    crNumber: text("cr_number"),
    molEstablishmentNo: text("mol_establishment_no"),
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("active"),
    ...timestamps,
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    check("sponsors_kind_ck", sql`${t.kind} in ('own','external')`),
    check("sponsors_status_ck", sql`${t.status} in ('active','archived')`),
    // One own sponsor per entity: the company itself.
    uniqueIndex("sponsors_one_own_uq").on(t.entityId).where(sql`${t.kind} = 'own'`),
    uniqueIndex("sponsors_cr_uq").on(t.entityId, sql`lower(${t.crNumber})`).where(sql`${t.crNumber} is not null`),
  ],
);

export const supplyAgreements = pgTable(
  "supply_agreements",
  {
    id: uuidV7(),
    entityId,
    payee: text("payee").notNull(),
    sponsorId: uuid("sponsor_id").references(() => sponsors.id, { onDelete: "restrict" }),
    supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "restrict" }),
    workerId: uuid("worker_id").references(() => workers.id, { onDelete: "restrict" }),
    reference: text("reference").notNull(),
    startDate: date("start_date", { mode: "string" }).notNull(),
    endDate: date("end_date", { mode: "string" }),
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),
    minBillableDays: integer("min_billable_days"),
    inclusions: jsonb("inclusions").notNull().default(sql`'{}'::jsonb`),
    status: text("status").notNull().default("draft"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    ...timestamps,
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [
    check("supply_agreements_payee_ck", sql`${t.payee} in ('sponsor','middleman','worker')`),
    check("supply_agreements_status_ck", sql`${t.status} in ('draft','approved')`),
    check("supply_agreements_dates_ck", sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`),
    // Exactly the columns its payee needs.
    check(
      "supply_agreements_payee_columns_ck",
      sql`(${t.payee} = 'sponsor' and ${t.sponsorId} is not null and ${t.supplierId} is not null and ${t.workerId} is null)
       or (${t.payee} = 'middleman' and ${t.supplierId} is not null and ${t.workerId} is null)
       or (${t.payee} = 'worker' and ${t.workerId} is not null and ${t.supplierId} is null)`,
    ),
    // Four eyes: whoever records the agreement cannot approve it.
    check("supply_agreements_four_eyes_ck", sql`${t.approvedBy} is null or ${t.approvedBy} <> ${t.createdBy}`),
    check("supply_agreements_approved_ck", sql`(${t.status} = 'approved') = (${t.approvedBy} is not null and ${t.approvedAt} is not null)`),
  ],
);

export const supplyRateLines = pgTable(
  "supply_rate_lines",
  {
    id: uuidV7(),
    entityId,
    supplyAgreementId: uuid("supply_agreement_id").notNull().references(() => supplyAgreements.id, { onDelete: "restrict" }),
    trade: text("trade").notNull(),
    hourType: text("hour_type").notNull(),
    unit: text("unit").notNull(),
    rate: numeric("rate", { precision: 14, scale: 3 }).notNull(),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    index("supply_rate_lines_agreement_idx").on(t.supplyAgreementId),
    check("supply_rate_lines_hour_type_ck", sql`${t.hourType} in ('normal','overtime','rest_day','holiday','night')`),
    check("supply_rate_lines_unit_ck", sql`${t.unit} in ('hour','day','month')`),
    check("supply_rate_lines_rate_ck", sql`${t.rate} >= 0`),
    check("supply_rate_lines_dates_ck", sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);

export const workerSponsorships = pgTable(
  "worker_sponsorships",
  {
    id: uuidV7(),
    entityId,
    workerId: uuid("worker_id").notNull().references(() => workers.id, { onDelete: "restrict" }),
    sponsorId: uuid("sponsor_id").references(() => sponsors.id, { onDelete: "restrict" }),
    engagement: text("engagement").notNull(),
    supplyAgreementId: uuid("supply_agreement_id").references(() => supplyAgreements.id, { onDelete: "restrict" }),
    authorisationRef: text("authorisation_ref"),
    authorisationFileId: uuid("authorisation_file_id"),
    consentFileId: uuid("consent_file_id"),
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    validTo: date("valid_to", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    index("worker_sponsorships_worker_idx").on(t.workerId),
    index("worker_sponsorships_sponsor_idx").on(t.sponsorId),
    check("worker_sponsorships_engagement_ck", sql`${t.engagement} in ('own','supplied','transferred','free_visa')`),
    check("worker_sponsorships_sponsor_ck", sql`${t.sponsorId} is not null or ${t.engagement} = 'free_visa'`),
    check("worker_sponsorships_own_ck", sql`${t.engagement} <> 'own' or (${t.supplyAgreementId} is null and ${t.authorisationRef} is null)`),
    check("worker_sponsorships_dates_ck", sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);

/** Non-legal company settings (Backend Schema "settings"), e.g. outsourcing.unauthorised (A22). */
export const settings = pgTable(
  "settings",
  {
    entityId,
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [primaryKey({ columns: [t.entityId, t.key] })],
);
