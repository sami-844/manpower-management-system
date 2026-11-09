import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { asc, gte } from "drizzle-orm";
import { auditEvents, users } from "../src/db/schema";
import { createTestApp, createWorker, ensureUser, nextOtp, signIn, type TestContext } from "./helpers";

// Regression tests for the security review of the authentication commit (2026-11-09).

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await ctx.reset();
  ctx.clock.advance(16 * 60_000);
  await ctx.signInAll();
});

let seq = 0;
const fresh = (roles: Parameters<typeof ensureUser>[2], opts: Parameters<typeof ensureUser>[3] = {}) =>
  ensureUser(ctx, `h${Date.now().toString(36)}${seq++}`, roles, opts);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("lockout holds under parallel guessing (reserve-then-verify)", () => {
  it("lets at most 5 of 12 simultaneous wrong passwords be checked, then refuses", async () => {
    const u = await fresh(["hr_pro"]);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => ctx.api(null).post("/api/auth/login").send({ username: u.username, password: "wrong-wrong-wrong" })),
    );
    const checked = results.filter((r) => r.status === 401).length;
    expect(checked).toBeLessThanOrEqual(5);
    expect(results.filter((r) => r.status === 423).length).toBe(12 - checked);
    const right = await ctx.api(null).post("/api/auth/login").send({ username: u.username, password: u.password, otp: await nextOtp(ctx, u) });
    expect(right.status).toBe(423);
  });

  it("a right password with no code yet does not use up a try", async () => {
    const u = await fresh(["hr_pro"]);
    for (let i = 0; i < 8; i++) {
      const r = await ctx.api(null).post("/api/auth/login").send({ username: u.username, password: u.password });
      expect(r.body.code).toBe("OTP_REQUIRED");
    }
    const [row] = await ctx.db.base.select().from(users).where(eq(users.id, u.id));
    expect(row!.failedSignIns).toBe(0);
  });

  it("limits a network under parallel guessing too", async () => {
    const limit = ctx.config.ipFailureLimit;
    const results = await Promise.all(
      Array.from({ length: limit + 10 }, (_, i) => ctx.api(null).post("/api/auth/login").send({ username: `nobody${i}`, password: "x-x-x-x-x-x" })),
    );
    expect(results.filter((r) => r.status === 401).length).toBeLessThanOrEqual(limit);
    expect(results.filter((r) => r.status === 429).length).toBeGreaterThanOrEqual(10);
  });
});

describe("password change honours the lockout", () => {
  it("refuses with 423 while the account is locked, even from a live session", async () => {
    const u = await fresh(["hr_pro"]);
    const { accessToken } = await signIn(ctx, u);
    const change = (currentPassword: string) =>
      ctx.api(null).post("/api/auth/change-password").set(bearer(accessToken)).send({ currentPassword, newPassword: "brand new long passphrase" });
    for (let i = 0; i < 5; i++) expect((await change("guess-number-" + i)).body.code).toBe("CURRENT_PASSWORD_WRONG");
    const locked = await change(u.password);
    expect(locked.status).toBe(423);
  });
});

describe("admins manage only their own company's users", () => {
  it("cannot see, reset or disable a user of another entity", async () => {
    const omanUser = await fresh(["hr_pro"]);
    const uaeAdmin = await fresh(["admin"], { entityId: "AE-01" });
    const { accessToken } = await signIn(ctx, uaeAdmin);

    const list = await ctx.api(null).get("/api/admin/users").set(bearer(accessToken));
    expect(list.status).toBe(200);
    const names = list.body.items.map((u: { username: string }) => u.username);
    expect(names).toContain(uaeAdmin.username);
    expect(names).not.toContain(omanUser.username);
    expect(names).not.toContain("hr.officer");

    for (const action of ["reset-password", "reset-2fa", "unlock", "disable"]) {
      const res = await ctx.api(null).post(`/api/admin/users/${omanUser.id}/${action}`).set(bearer(accessToken));
      expect(res.status).toBe(404);
    }
    const roles = await ctx.api(null).put(`/api/admin/users/${omanUser.id}/roles`).set(bearer(accessToken)).send({ roles: ["admin"] });
    expect(roles.status).toBe(404);
    const [row] = await ctx.db.base.select().from(users).where(eq(users.id, omanUser.id));
    expect(row!.status).toBe("active");
  });

  it("refuses to change a user who also works for another company", async () => {
    const both = await fresh(["hr_pro"]);
    await ctx.db.base.execute(
      // A second active membership in AE-01 for the same person.
      (await import("drizzle-orm")).sql`insert into user_roles (id, user_id, role_key, entity_id, valid_from, created_by)
        values (${Bun.randomUUIDv7()}, ${both.id}, 'hr_pro', 'AE-01', '2026-01-01', 'test')`,
    );
    const res = await ctx.api("sys.admin").post(`/api/admin/users/${both.id}/disable`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("USER_IN_OTHER_ENTITY");
  });
});

describe("the audit trail is scoped by entity and stays one chain", () => {
  it("hides another company's history, while every new event still links to the one chain", async () => {
    const [mark] = await ctx.db.base.select({ id: auditEvents.id }).from(auditEvents).orderBy(asc(auditEvents.id)).limit(1).offset(0);
    const before = await ctx.db.base.select({ id: auditEvents.id }).from(auditEvents);
    const startId = Math.max(mark?.id ?? 0, ...before.map((r) => r.id));
    const uae = await fresh(["hr_pro"], { entityId: "AE-01" });
    const { accessToken } = await signIn(ctx, uae);
    const theirs = await ctx.api(null).post("/api/workers").set(bearer(accessToken)).send({ fullName: "UAE Audit", nationality: "India", trade: "Mason" });
    const ours = await createWorker(ctx, { fullName: "Oman Audit" }, []);
    await ctx.api(null).post("/api/workers").set(bearer(accessToken)).send({ fullName: "UAE Audit 2", nationality: "India", trade: "Mason" });

    expect((await ctx.api("hr.officer").get("/api/audit").query({ subjectId: theirs.body.id })).body.items).toEqual([]);
    expect((await ctx.api(null).get("/api/audit").query({ subjectId: ours.id }).set(bearer(accessToken))).body.items).toEqual([]);
    expect((await ctx.api(null).get("/api/audit").query({ subjectId: theirs.body.id }).set(bearer(accessToken))).body.items).toHaveLength(1);

    // Other test files deliberately forge a row to prove tamper detection, so check the links made
    // here: each new event's prev_hash is the hash of the event just before it, whatever its entity.
    const rows = await ctx.db.base.select().from(auditEvents).where(gte(auditEvents.id, startId)).orderBy(asc(auditEvents.id));
    expect(rows.length).toBeGreaterThan(3);
    expect(new Set(rows.map((r) => r.entityId))).toEqual(new Set(["OM-01", "AE-01"]));
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.prevHash).toBe(rows[i - 1]!.hash);
  });
});
