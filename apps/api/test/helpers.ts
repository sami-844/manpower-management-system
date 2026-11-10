import "reflect-metadata";
import { createHash } from "node:crypto";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { eq } from "drizzle-orm";
import request from "supertest";
import { AppModule, configureApp } from "../src/app.module";
import { AUTH_CONFIG, type AuthConfig } from "../src/auth/config";
import { base32Encode, seal, totpCode } from "../src/auth/crypto";
import { hashPassword } from "../src/auth/passwords";
import type { RoleKey } from "../src/auth/permissions";
import { CLOCK, type Clock } from "../src/common/clock";
import { DB, type Database } from "../src/db/client";
import { userRoles, users } from "../src/db/schema";

export const TODAY = "2026-10-14";
const START_MS = Date.parse(`${TODAY}T06:00:00Z`);

/** A test clock: frozen until a test moves it. `today` stays the fixture date unless a test sets it. */
export interface TestClock extends Clock {
  advance(ms: number): void;
}

/** The people the existing tests act as (names match the audit actors they assert on). */
export const STANDARD_USERS: Record<string, RoleKey[]> = {
  "hr.officer": ["hr_pro"],
  "hr.lead": ["hr_pro"],
  pro: ["hr_pro"],
  "ops.manager": ["ops_manager"],
  "owner.gm": ["owner"],
  "payroll.officer": ["payroll"],
  "finance.officer": ["finance"],
  "sys.admin": ["admin"],
};

export interface TestUser {
  id: string;
  username: string;
  password: string;
  totpSecret: string | null;
}

type Api = ReturnType<typeof request>;

export interface TestContext {
  app: INestApplication;
  db: Database;
  clock: TestClock;
  config: AuthConfig;
  /** Requests as a signed-in standard user (default hr.officer), or with no token when `null`. */
  api: (as?: string | null) => Api;
  /** Sign every standard user in again (after moving the clock past the access-token lifetime). */
  signInAll: () => Promise<void>;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/** Deterministic per username, so test users can be re-created idempotently across test files. */
export const testPassword = (username: string) => `pw-${createHash("sha256").update(username).digest("hex").slice(0, 16)}`;
export const testTotpSecret = (username: string) => base32Encode(createHash("sha1").update(`totp:${username}`).digest());

/** Insert a user directly (an admin would normally create them); idempotent by username. */
export async function ensureUser(
  ctx: Pick<TestContext, "db" | "config">,
  username: string,
  roles: RoleKey[],
  opts: { mustChangePassword?: boolean; totp?: boolean; entityId?: string; status?: "active" | "disabled" } = {},
): Promise<TestUser> {
  const password = testPassword(username);
  const totpSecret = opts.totp === false ? null : testTotpSecret(username);
  const [existing] = await ctx.db.base.select().from(users).where(eq(users.username, username));
  if (existing) return { id: existing.id, username, password, totpSecret: existing.totpSecretSealed ? totpSecret : null };
  const [user] = await ctx.db.base
    .insert(users)
    .values({
      username,
      displayName: username,
      passwordHash: await hashPassword(password),
      isPasswordChangeRequired: opts.mustChangePassword ?? false,
      status: opts.status ?? "active",
      totpSecretSealed: totpSecret ? seal(totpSecret, ctx.config.sealKey) : null,
      createdBy: "test",
      updatedBy: "test",
    })
    .returning();
  if (roles.length) {
    await ctx.db.base
      .insert(userRoles)
      .values(roles.map((role) => ({ userId: user!.id, roleKey: role, entityId: opts.entityId ?? "OM-01", validFrom: "2026-01-01", createdBy: "test" })));
  }
  return { id: user!.id, username, password, totpSecret };
}

/**
 * The current authenticator code. Each code works once, so if this user already used this step
 * (users persist across test files), the clock moves on to a fresh step.
 */
export async function nextOtp(ctx: Pick<TestContext, "clock" | "db">, user: TestUser): Promise<string> {
  const [row] = await ctx.db.base.select({ last: users.totpLastStep }).from(users).where(eq(users.username, user.username));
  let step = Math.floor(ctx.clock.now() / 30_000);
  while ((row?.last ?? -1) >= step) {
    ctx.clock.advance(30_000);
    step += 1;
  }
  return totpCode(user.totpSecret!, step);
}

export async function signIn(ctx: TestContext, user: TestUser): Promise<{ accessToken: string; cookie: string; body: Record<string, unknown> }> {
  const res = await ctx
    .api(null)
    .post("/api/auth/login")
    .send({ username: user.username, password: user.password, otp: user.totpSecret ? await nextOtp(ctx, user) : undefined });
  if (res.status !== 200) throw new Error(`sign-in failed for ${user.username}: ${res.status} ${JSON.stringify(res.body)}`);
  const cookie = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("mms_refresh="))!;
  return { accessToken: res.body.accessToken, cookie: cookie.split(";")[0]!, body: res.body };
}

export async function createTestApp(today = TODAY): Promise<TestContext> {
  let nowMs = START_MS;
  const clock: TestClock = {
    today: () => today,
    now: () => nowMs,
    advance: (ms) => {
      nowMs += ms;
    },
  };
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  const db = app.get<Database>(DB);
  const config = app.get<AuthConfig>(AUTH_CONFIG);
  const tokens = new Map<string, string>();

  const api = (as: string | null = "hr.officer"): Api => {
    const agent = request(app.getHttpServer());
    if (as === null) return agent;
    const token = tokens.get(as);
    if (!token) throw new Error(`No test session for "${as}"`);
    const withToken = <M extends "get" | "post" | "put" | "patch" | "delete">(method: M) =>
      ((url: string) => agent[method](url).set("authorization", `Bearer ${token}`)) as Api[M];
    return { ...agent, get: withToken("get"), post: withToken("post"), put: withToken("put"), patch: withToken("patch"), delete: withToken("delete") } as Api;
  };

  const ctx: TestContext = {
    app,
    db,
    clock,
    config,
    api,
    signInAll: async () => {
      for (const [username, roles] of Object.entries(STANDARD_USERS)) {
        const user = await ensureUser(ctx, username, roles);
        tokens.set(username, (await signIn(ctx, user)).accessToken);
      }
    },
    // audit_events is append-only by design, so tests filter it by subject instead of clearing it.
    reset: async () => {
      await db.sql`TRUNCATE leave_periods, compliance_overrides, worker_documents, organisation_documents, files, clients, sites, workers RESTART IDENTITY CASCADE`;
    },
    close: async () => {
      await app.close();
    },
  };
  await ctx.signInAll();
  return ctx;
}

export const validDocs = (expiry = "2027-12-31") => [
  { type: "passport", number: "P1234567", expiryDate: expiry },
  { type: "residence_visa", number: "V-998877", expiryDate: expiry },
  { type: "labour_card", number: "LC-445566", expiryDate: expiry },
  { type: "medical", expiryDate: expiry },
  { type: "civil_id", number: "OM-12345678", expiryDate: expiry },
  { type: "medical_insurance", number: "MI-2026-001", expiryDate: expiry },
];

export async function createWorker(
  ctx: TestContext,
  over: Record<string, unknown> = {},
  docs = validDocs(),
): Promise<{ id: string; code: string }> {
  const res = await ctx
    .api("hr.officer")
    .post("/api/workers")
    .send({ fullName: "Test Worker", nationality: "Bangladesh", trade: "Mason", ...over });
  if (res.status !== 201) throw new Error(`createWorker failed: ${res.status} ${JSON.stringify(res.body)}`);
  for (const d of docs) {
    const r = await ctx.api("hr.officer").post(`/api/workers/${res.body.id}/documents`).send({ ...d, verified: true });
    if (r.status !== 201) throw new Error(`add document failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return res.body;
}
