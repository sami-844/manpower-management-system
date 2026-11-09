import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MetadataScanner, ModulesContainer, Reflector } from "@nestjs/core";
import { asc, eq, sql } from "drizzle-orm";
import { totpCode } from "../src/auth/crypto";
import { ACCESS, PERMISSIONS } from "../src/auth/permissions";
import { auditEvents, loginAttempts, permissions, userSessions, users } from "../src/db/schema";
import { createTestApp, createWorker, ensureUser, nextOtp, signIn, type TestContext, type TestUser } from "./helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await ctx.reset();
  // A fresh 15-minute window for the per-network limit, and fresh tokens for the standard users.
  ctx.clock.advance(16 * 60_000);
  await ctx.signInAll();
});

const MIN = 60_000;
let seq = 0;
/** A fresh user per test, so lockouts and one-time codes never leak between tests. */
const freshUser = (roles: Parameters<typeof ensureUser>[2] = ["hr_pro"], opts: Parameters<typeof ensureUser>[3] = {}) =>
  ensureUser(ctx, `t${Date.now().toString(36)}${seq++}`, roles, opts);

const login = async (u: TestUser, otp?: string) =>
  ctx.api(null).post("/api/auth/login").send({ username: u.username, password: u.password, otp });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const refreshWith = (cookie: string) => ctx.api(null).post("/api/auth/refresh").set("cookie", cookie);
const cookieOf = (res: { headers: Record<string, unknown> }) =>
  ([] as string[]).concat((res.headers["set-cookie"] as string[]) ?? []).find((c) => c.startsWith("mms_refresh="));

describe("sign in", () => {
  it("answers an unknown user and a wrong password the same way, and records both", async () => {
    const u = await freshUser();
    const unknown = await ctx.api(null).post("/api/auth/login").send({ username: "nobody.here", password: "whatever-it-is" });
    const wrong = await ctx.api(null).post("/api/auth/login").send({ username: u.username, password: "not-the-password" });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(wrong.body.code).toBe("INVALID_CREDENTIALS");
    const rows = await ctx.db.base.select().from(loginAttempts).where(eq(loginAttempts.username, u.username));
    expect(rows.map((r) => r.reason)).toContain("bad_password");
    const unknownRows = await ctx.db.base.select().from(loginAttempts).where(eq(loginAttempts.username, "nobody.here"));
    expect(unknownRows.map((r) => r.reason)).toContain("unknown_user");
  });

  it("asks for the authenticator code, refuses a wrong one, and accepts the right one", async () => {
    const u = await freshUser();
    expect((await login(u)).body.code).toBe("OTP_REQUIRED");
    expect((await login(u, "000000")).body.code).toBe("OTP_INVALID");
    const ok = await login(u, await nextOtp(ctx, u));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ expiresIn: 900, user: { username: u.username }, next: null });
    expect(ok.body.accessToken).toBeString();
    expect(JSON.stringify(ok.body)).not.toContain("refresh");
  });

  it("accepts each code only once", async () => {
    const u = await freshUser();
    const code = await nextOtp(ctx, u);
    expect((await login(u, code)).status).toBe(200);
    expect((await login(u, code)).body.code).toBe("OTP_INVALID");
  });

  it("sets the refresh token only as an httpOnly, Secure, SameSite=Strict cookie on /api/auth", async () => {
    const u = await freshUser();
    const cookie = cookieOf(await login(u, await nextOtp(ctx, u)))!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/auth");
  });

  it("locks an account for 15 minutes after 5 failures, then lets it in again", async () => {
    const u = await freshUser();
    for (let i = 0; i < 5; i++) await ctx.api(null).post("/api/auth/login").send({ username: u.username, password: "wrong-password!" });
    const locked = await login(u, await nextOtp(ctx, u));
    expect(locked.status).toBe(423);
    expect(locked.body).toMatchObject({ code: "ACCOUNT_LOCKED" });
    expect(locked.body.retryAfterSeconds).toBeGreaterThan(0);
    const audit = await ctx.db.base.select().from(auditEvents).where(eq(auditEvents.subjectId, u.id));
    expect(audit.map((e) => e.action)).toContain("auth.lockout");

    ctx.clock.advance(15 * MIN + 1_000);
    expect((await login(u, await nextOtp(ctx, u))).status).toBe(200);
  });

  it("counts wrong authenticator codes toward the lockout", async () => {
    const u = await freshUser();
    for (let i = 0; i < 5; i++) await login(u, "000000");
    expect((await login(u, await nextOtp(ctx, u))).status).toBe(423);
  });

  it("refuses a network after too many failures in 15 minutes", async () => {
    const u = await freshUser();
    const limit = ctx.config.ipFailureLimit;
    for (let i = 0; i < limit; i++) await ctx.api(null).post("/api/auth/login").send({ username: `ghost${i}`, password: "nope-nope-nope" });
    const res = await login(u, await nextOtp(ctx, u));
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("TOO_MANY_ATTEMPTS");
  });

  it("refuses a disabled account even with the right password", async () => {
    const u = await freshUser(["hr_pro"], { status: "disabled" });
    const res = await login(u, await nextOtp(ctx, u));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_DISABLED");
  });
});

describe("first sign-in: temporary password, then the authenticator", () => {
  it("allows nothing but set-up until both are done", async () => {
    const u = await freshUser(["hr_pro"], { mustChangePassword: true, totp: false });
    const first = await login(u);
    expect(first.body.next).toBe("change_password");
    const token = first.body.accessToken as string;

    const blocked = await ctx.api(null).get("/api/workers").set(bearer(token));
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await ctx.api(null).get("/api/auth/me").set(bearer(token))).body).toMatchObject({ next: "change_password", roles: ["hr_pro"] });
    expect((await ctx.api(null).post("/api/auth/2fa/setup").set(bearer(token))).body.code).toBe("PASSWORD_CHANGE_REQUIRED");

    const change = (currentPassword: string, newPassword: string) =>
      ctx.api(null).post("/api/auth/change-password").set(bearer(token)).send({ currentPassword, newPassword });
    expect((await change("wrong-current-pw", "a perfectly long passphrase")).body.code).toBe("CURRENT_PASSWORD_WRONG");
    const weak = await change(u.password, "short");
    expect(weak.body).toMatchObject({ code: "PASSWORD_POLICY", problems: ["At least 12 characters"] });
    expect((await change(u.password, u.password)).body.code).toBe("PASSWORD_REUSED");
    const changed = await change(u.password, "a perfectly long passphrase");
    expect(changed.status).toBe(200);
    expect(changed.body.next).toBe("setup_2fa");

    const stillBlocked = await ctx.api(null).get("/api/workers").set(bearer(token));
    expect(stillBlocked.body.code).toBe("TWO_FACTOR_SETUP_REQUIRED");

    const setup = await ctx.api(null).post("/api/auth/2fa/setup").set(bearer(token));
    expect(setup.body.otpauthUrl).toStartWith("otpauth://totp/");
    expect((await ctx.api(null).post("/api/auth/2fa/confirm").set(bearer(token)).send({ code: "000000" })).body.code).toBe("OTP_INVALID");
    const confirmed = await ctx
      .api(null)
      .post("/api/auth/2fa/confirm")
      .set(bearer(token))
      .send({ code: totpCode(setup.body.secret, Math.floor(ctx.clock.now() / 30_000)) });
    expect(confirmed.body).toEqual({ next: null });

    expect((await ctx.api(null).get("/api/workers").set(bearer(token))).status).toBe(200);
    const again = await ctx.api(null).post("/api/auth/login").send({ username: u.username, password: "a perfectly long passphrase" });
    expect(again.body.code).toBe("OTP_REQUIRED");
  });

  it("ends the user's other sessions when the password changes", async () => {
    const u = await freshUser();
    const a = await signIn(ctx, u);
    const b = await signIn(ctx, u);
    const res = await ctx
      .api(null)
      .post("/api/auth/change-password")
      .set(bearer(a.accessToken))
      .send({ currentPassword: u.password, newPassword: "another long passphrase" });
    expect(res.status).toBe(200);
    expect((await ctx.api(null).get("/api/workers").set(bearer(a.accessToken))).status).toBe(200);
    expect((await ctx.api(null).get("/api/workers").set(bearer(b.accessToken))).body.code).toBe("SESSION_ENDED");
  });
});

describe("tokens and sessions", () => {
  it("refuses a missing, tampered or expired access token", async () => {
    expect((await ctx.api(null).get("/api/workers")).body.code).toBe("TOKEN_MISSING");
    const u = await freshUser();
    const { accessToken } = await signIn(ctx, u);
    const [h, p, s] = accessToken.split(".");
    const tampered = `${h}.${p}.${s!.slice(0, -2)}xx`;
    expect((await ctx.api(null).get("/api/workers").set(bearer(tampered))).body.code).toBe("TOKEN_INVALID");
    ctx.clock.advance(15 * MIN);
    expect((await ctx.api(null).get("/api/workers").set(bearer(accessToken))).body.code).toBe("TOKEN_INVALID");
  });

  it("rotates the refresh token; the previous one works only for a 30-second grace", async () => {
    const u = await freshUser();
    const { cookie } = await signIn(ctx, u);
    const first = await refreshWith(cookie);
    expect(first.status).toBe(200);
    const rotated = cookieOf(first)!.split(";")[0]!;
    expect(rotated).not.toBe(cookie);
    expect((await refreshWith(cookie)).status).toBe(200); // racing tab, inside the grace
    const latest = await refreshWith(rotated);
    expect(latest.status).toBe(200);
    expect(latest.body.accessToken).toBeString();
  });

  it("treats a stale refresh token as theft: the whole session ends", async () => {
    const u = await freshUser();
    const { cookie, accessToken } = await signIn(ctx, u);
    const r1 = cookieOf(await refreshWith(cookie))!.split(";")[0]!;
    const r2res = await refreshWith(r1);
    const r2 = cookieOf(r2res)!.split(";")[0]!;
    ctx.clock.advance(31_000);
    const stolen = await refreshWith(cookie);
    expect(stolen.status).toBe(401);
    expect(stolen.body.code).toBe("SESSION_ENDED");
    expect((await refreshWith(r2)).status).toBe(401);
    expect((await ctx.api(null).get("/api/workers").set(bearer(r2res.body.accessToken))).status).toBe(401);
    expect((await ctx.api(null).get("/api/workers").set(bearer(accessToken))).status).toBe(401);
    const [s] = await ctx.db.base.select().from(userSessions).where(eq(userSessions.userId, u.id));
    expect(s!.revokeReason).toBe("refresh_token_reused");
  });

  it("ends a session after 30 minutes without activity, but not while it is used", async () => {
    const u = await freshUser();
    let { cookie } = await signIn(ctx, u);
    for (let i = 0; i < 4; i++) {
      ctx.clock.advance(20 * MIN);
      const res = await refreshWith(cookie);
      expect(res.status).toBe(200);
      cookie = cookieOf(res)!.split(";")[0]!;
    }
    ctx.clock.advance(31 * MIN);
    expect((await refreshWith(cookie)).body.code).toBe("SESSION_ENDED");
  });

  it("ends every session after 12 hours however busy", async () => {
    const u = await freshUser();
    let { cookie } = await signIn(ctx, u);
    for (let elapsed = 0; elapsed < 12 * 60 - 20; elapsed += 20) {
      ctx.clock.advance(20 * MIN);
      const res = await refreshWith(cookie);
      expect(res.status).toBe(200);
      cookie = cookieOf(res)!.split(";")[0]!;
    }
    ctx.clock.advance(20 * MIN);
    expect((await refreshWith(cookie)).status).toBe(401);
  });

  it("signs out on the server: the access token stops working at once", async () => {
    const u = await freshUser();
    const { accessToken, cookie } = await signIn(ctx, u);
    const out = await ctx.api(null).post("/api/auth/logout").set(bearer(accessToken)).set("cookie", cookie);
    expect(out.status).toBe(204);
    expect(cookieOf(out)).toContain("Expires=Thu, 01 Jan 1970");
    expect((await ctx.api(null).get("/api/workers").set(bearer(accessToken))).body.code).toBe("SESSION_ENDED");
    expect((await refreshWith(cookie)).status).toBe(401);
  });

  it("limits each user to the configured requests per minute", async () => {
    const u = await freshUser();
    const { accessToken } = await signIn(ctx, u);
    const saved = ctx.config.requestsPerMinute;
    ctx.config.requestsPerMinute = 3;
    try {
      for (let i = 0; i < 3; i++) expect((await ctx.api(null).get("/api/workers").set(bearer(accessToken))).status).toBe(200);
      expect((await ctx.api(null).get("/api/workers").set(bearer(accessToken))).body.code).toBe("RATE_LIMITED");
      ctx.clock.advance(MIN);
      expect((await ctx.api(null).get("/api/workers").set(bearer(accessToken))).status).toBe(200);
    } finally {
      ctx.config.requestsPerMinute = saved;
    }
  });
});

describe("permissions (default deny)", () => {
  it("every route declares public, signed-in or a permission", () => {
    const scanner = new MetadataScanner();
    const reflector = ctx.app.get(Reflector);
    const controllers = [...ctx.app.get(ModulesContainer).values()].flatMap((m) => [...m.controllers.values()]);
    const undeclared: string[] = [];
    let routes = 0;
    for (const wrapper of controllers) {
      const proto = Object.getPrototypeOf(wrapper.instance);
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = proto[name];
        if (!Reflect.getMetadata("path", handler)) continue;
        routes += 1;
        if (!reflector.getAllAndOverride(ACCESS, [handler, wrapper.metatype])) undeclared.push(`${wrapper.name}.${name}`);
      }
    }
    expect(routes).toBeGreaterThan(20);
    expect(undeclared).toEqual([]);
  });

  it("the database catalogue and the code catalogue list the same permissions", async () => {
    const rows = await ctx.db.base.select({ key: permissions.key }).from(permissions).orderBy(asc(permissions.key));
    expect(rows.map((r) => r.key)).toEqual([...PERMISSIONS].sort());
  });

  it("refuses an action the role does not hold, and records the real user on what it allows", async () => {
    const denied = await ctx.api("payroll.officer").post("/api/workers").send({ fullName: "X Y", nationality: "India", trade: "Mason" });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe("FORBIDDEN");
    const w = await createWorker(ctx, { fullName: "Allowed" }, []);
    const audit = await ctx.api("hr.officer").get("/api/audit").query({ subjectId: w.id });
    expect(audit.body.items[0].actor).toBe("hr.officer");
  });

  it("a signed-in user with no role reaches only their own profile", async () => {
    const u = await freshUser([]);
    const { accessToken } = await signIn(ctx, u);
    expect((await ctx.api(null).get("/api/auth/me").set(bearer(accessToken))).body).toMatchObject({ roles: [], permissions: [] });
    expect((await ctx.api(null).get("/api/workers").set(bearer(accessToken))).body.code).toBe("NO_ROLE");
  });
});

describe("row-level security by entity (TR-SEC-05)", () => {
  it("a user in another company sees and writes only that company's rows", async () => {
    await createWorker(ctx, { fullName: "Oman Worker" }, []);
    const uae = await freshUser(["hr_pro"], { entityId: "AE-01" });
    const { accessToken } = await signIn(ctx, uae);
    const theirs = await ctx.api(null).post("/api/workers").set(bearer(accessToken)).send({ fullName: "UAE Worker", nationality: "India", trade: "Mason" });
    expect(theirs.status).toBe(201);

    const seenByUae = await ctx.api(null).get("/api/workers").set(bearer(accessToken));
    expect(seenByUae.body.items.map((w: { fullName: string }) => w.fullName)).toEqual(["UAE Worker"]);
    const seenByOman = await ctx.api("hr.officer").get("/api/workers");
    expect(seenByOman.body.items.map((w: { fullName: string }) => w.fullName)).toEqual(["Oman Worker"]);
    expect((await ctx.api("hr.officer").get(`/api/workers/${theirs.body.id}`)).status).toBe(404);
  });

  it("the database itself returns nothing to mms_app when no entity is set", async () => {
    await createWorker(ctx, { fullName: "Hidden" }, []);
    const rows = await ctx.db.sql.begin(async (tx) => {
      await tx`set local role mms_app`;
      return tx`select count(*)::int as n from workers`;
    });
    expect(rows[0]!.n).toBe(0);
  });

  it("mms_app can never delete, and cannot rewrite the permission catalogue", async () => {
    await createWorker(ctx, {}, []);
    const attempt = (stmt: string) =>
      ctx.db.sql.begin(async (tx) => {
        await tx`set local role mms_app`;
        await tx`select set_config('app.entity_id', 'OM-01', true)`;
        await tx.unsafe(stmt);
      });
    await expect(attempt("delete from workers")).rejects.toThrow(/permission denied/);
    await expect(attempt("insert into role_permissions values ('payroll', 'users.manage')")).rejects.toThrow(/permission denied/);
  });
});

describe("admin: user accounts", () => {
  it("creates a user with a one-time temporary password that must be changed", async () => {
    const created = await ctx.api("sys.admin").post("/api/admin/users").send({ username: "new.clerk", displayName: "New Clerk", roles: ["hr_pro"] });
    expect(created.status).toBe(201);
    expect(created.body.temporaryPassword).toHaveLength(16);
    expect(JSON.stringify(created.body.user)).not.toMatch(/hash|totp_|secret/i);
    const first = await ctx.api(null).post("/api/auth/login").send({ username: "New.Clerk", password: created.body.temporaryPassword });
    expect(first.body.next).toBe("change_password");
    expect((await ctx.api("sys.admin").post("/api/admin/users").send({ username: "new.clerk", displayName: "Again", roles: ["hr_pro"] })).body.code).toBe(
      "USERNAME_TAKEN",
    );
  });

  it("is refused to everyone without users.manage", async () => {
    expect((await ctx.api("owner.gm").get("/api/admin/users")).status).toBe(403);
    expect((await ctx.api("hr.officer").post("/api/admin/users").send({ username: "sneaky", displayName: "Sneaky", roles: ["admin"] })).status).toBe(403);
  });

  it("a password reset ends the user's sessions and forces a change", async () => {
    const u = await freshUser();
    const { accessToken } = await signIn(ctx, u);
    const reset = await ctx.api("sys.admin").post(`/api/admin/users/${u.id}/reset-password`);
    expect(reset.status).toBe(201);
    expect((await ctx.api(null).get("/api/workers").set(bearer(accessToken))).body.code).toBe("SESSION_ENDED");
    const again = await ctx.api(null).post("/api/auth/login").send({ username: u.username, password: reset.body.temporaryPassword, otp: await nextOtp(ctx, u) });
    expect(again.body.next).toBe("change_password");
  });

  it("disable ends sessions and blocks sign-in; enable restores it", async () => {
    const u = await freshUser();
    const { accessToken } = await signIn(ctx, u);
    expect((await ctx.api("sys.admin").post(`/api/admin/users/${u.id}/disable`)).status).toBe(201);
    expect((await ctx.api(null).get("/api/workers").set(bearer(accessToken))).status).toBe(401);
    expect((await login(u, await nextOtp(ctx, u))).body.code).toBe("ACCOUNT_DISABLED");
    await ctx.api("sys.admin").post(`/api/admin/users/${u.id}/enable`);
    expect((await login(u, await nextOtp(ctx, u))).status).toBe(200);
  });

  it("changing roles changes permissions on the next request", async () => {
    const u = await freshUser(["payroll"]);
    const { accessToken } = await signIn(ctx, u);
    const create = () => ctx.api(null).post("/api/workers").set(bearer(accessToken)).send({ fullName: "Role Test", nationality: "India", trade: "Mason" });
    expect((await create()).status).toBe(403);
    expect((await ctx.api("sys.admin").put(`/api/admin/users/${u.id}/roles`).send({ roles: ["hr_pro"] })).status).toBe(200);
    expect((await create()).status).toBe(201);
  });

  it("an admin cannot disable themselves or drop their own admin role", async () => {
    const [admin] = await ctx.db.base.select().from(users).where(eq(users.username, "sys.admin"));
    expect((await ctx.api("sys.admin").post(`/api/admin/users/${admin!.id}/disable`)).body.code).toBe("CANNOT_DISABLE_SELF");
    expect((await ctx.api("sys.admin").put(`/api/admin/users/${admin!.id}/roles`).send({ roles: ["owner"] })).body.code).toBe("CANNOT_REMOVE_OWN_ADMIN");
  });

  it("unlock lifts a lockout", async () => {
    const u = await freshUser();
    for (let i = 0; i < 5; i++) await ctx.api(null).post("/api/auth/login").send({ username: u.username, password: "wrong-password!" });
    expect((await login(u, await nextOtp(ctx, u))).status).toBe(423);
    await ctx.api("sys.admin").post(`/api/admin/users/${u.id}/unlock`);
    expect((await login(u, await nextOtp(ctx, u))).status).toBe(200);
  });

  it("never writes a password hash, secret or token into the audit trail", async () => {
    const u = await freshUser();
    await signIn(ctx, u);
    await ctx.api("sys.admin").post(`/api/admin/users/${u.id}/reset-password`);
    await ctx.api("sys.admin").post(`/api/admin/users/${u.id}/reset-2fa`);
    const rows = await ctx.db.base.select().from(auditEvents).where(eq(auditEvents.subjectId, u.id));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(rows.map((r) => [r.before, r.after]));
    expect(text).not.toMatch(/argon2|password_?hash|totp_?secret|sealed|v1\.|refresh/i);
    const [chain] = await ctx.db.base.select({ n: sql<number>`count(*)::int` }).from(auditEvents);
    expect(chain!.n).toBeGreaterThan(0);
  });
});
