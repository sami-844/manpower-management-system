import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { prepareClientDemo } from "../src/deploy/client-demo";
import { MAX_LENGTH, MIN_LENGTH, verifyPassword } from "../src/auth/passwords";
import { DEMO_USERS } from "../src/auth/accounts";
import { DEMO_PASSWORD_LENGTH, DEMO_USERNAMES } from "../../cloudflare/src/config";

// The Cloudflare client demo's container start (DECISIONS A32): on an empty database it migrates,
// seeds fictional data once and creates the six role accounts with the deployer's demo password.

const base = process.env.DATABASE_URL ?? "postgres://mms:mms@localhost:5432/mms_test";
const name = `mms_test_demo_${Date.now().toString(36)}`;
const url = base.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
const admin = postgres(base, { onnotice: () => {} });
const PASSWORD = "four quiet harbour lamps";
const env = { DEPLOYMENT: "cloudflare-demo", DATABASE_URL: url, DEMO_PASSWORD: PASSWORD, SEED_WORKERS: "12" };

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${name}`);
});
afterAll(async () => {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
});

describe("client demo start-up (A32)", () => {
  it("migrates an empty database, seeds fictional data once and creates the six role accounts", async () => {
    const first = await prepareClientDemo(env);
    expect(first.seeded).toBe(true);
    expect(first.accountsCreated.sort()).toEqual(["admin", "finance.officer", "hr.officer", "ops.manager", "owner", "payroll.officer"]);

    const sql = postgres(url, { onnotice: () => {} });
    try {
      const [workerCount] = await sql<{ n: number }[]>`select count(*)::int as n from workers`;
      expect(workerCount!.n).toBe(12);
      const accounts = await sql<{ username: string; must: boolean; hash: string; roles: string[] }[]>`
        select u.username, u.is_password_change_required as must, u.password_hash as hash, array_agg(r.role_key order by r.role_key) as roles
        from users u join user_roles r on r.user_id = u.id group by u.id order by u.username`;
      expect(accounts.map((a) => [a.username, a.roles])).toEqual([
        ["admin", ["admin"]],
        ["finance.officer", ["finance"]],
        ["hr.officer", ["hr_pro"]],
        ["ops.manager", ["ops_manager"]],
        ["owner", ["owner"]],
        ["payroll.officer", ["payroll"]],
      ]);
      // The deployer chose the password, so nobody is made to replace it; it is stored only as a hash.
      expect(accounts.every((a) => !a.must && !a.hash.includes(PASSWORD))).toBe(true);
      expect(await verifyPassword(PASSWORD, accounts[0]!.hash)).toBe(true);
      const audited = await sql`select 1 from audit_events where action = 'user.create' and actor = 'system:client-demo'`;
      expect(audited.length).toBe(6);
      // Row-level security works for the connecting user (migration 0013).
      await sql.begin(async (tx) => {
        await tx`set local role mms_app`;
      });
    } finally {
      await sql.end();
    }

    // A restart (the container sleeps when idle) changes nothing.
    const again = await prepareClientDemo(env);
    expect(again).toEqual({ seeded: false, accountsCreated: [], accountsReset: [] });
    const sql2 = postgres(url, { onnotice: () => {} });
    try {
      const [workerCount] = await sql2<{ n: number }[]>`select count(*)::int as n from workers`;
      expect(workerCount!.n).toBe(12);
    } finally {
      await sql2.end();
    }
  });

  it("puts the shared demo accounts back on every start, whatever a visitor did to them", async () => {
    await prepareClientDemo(env);
    const sql = postgres(url, { onnotice: () => {} });
    try {
      // A visitor signed in as hr.officer changed its password and turned on two-factor; someone else
      // locked it with wrong guesses, and the demo admin disabled it and removed its role.
      const [hr] = await sql<{ id: string }[]>`select id from users where username = 'hr.officer'`;
      await sql`update users set password_hash = 'not-the-demo-password', totp_secret_sealed = 'sealed', totp_pending_sealed = 'pending',
        failed_sign_ins = 4, locked_until = now() + interval '10 minutes', status = 'disabled', is_password_change_required = true where id = ${hr!.id}`;
      await sql`update user_roles set revoked_at = now(), revoked_by = 'admin' where user_id = ${hr!.id}`;
      await sql`insert into user_sessions (id, user_id, refresh_hash, created_at, last_seen_at, expires_at)
        values (gen_random_uuid(), ${hr!.id}, repeat('a', 64), now(), now(), now() + interval '1 hour')`;

      const r = await prepareClientDemo(env);
      expect(r).toEqual({ seeded: false, accountsCreated: [], accountsReset: ["hr.officer"] });
      const [after] = await sql<{ hash: string; totp: string | null; pending: string | null; failed: number; locked: Date | null; status: string; must: boolean }[]>`
        select password_hash as hash, totp_secret_sealed as totp, totp_pending_sealed as pending, failed_sign_ins as failed,
               locked_until as locked, status, is_password_change_required as must from users where id = ${hr!.id}`;
      expect(await verifyPassword(PASSWORD, after!.hash)).toBe(true);
      expect([after!.totp, after!.pending, after!.failed, after!.locked, after!.status, after!.must]).toEqual([null, null, 0, null, "active", false]);
      const roles = await sql`select role_key from user_roles where user_id = ${hr!.id} and revoked_at is null`;
      expect(roles.map((x) => x.role_key)).toEqual(["hr_pro"]);
      const live = await sql`select 1 from user_sessions where user_id = ${hr!.id} and revoked_at is null`;
      expect(live.length).toBe(0);
      const audited = await sql`select 1 from audit_events where action = 'user.demo_reset' and subject_id = ${hr!.id}::text`;
      expect(audited.length).toBe(1);
      // A start with nothing to put back changes nothing.
      expect((await prepareClientDemo(env)).accountsReset).toEqual([]);
    } finally {
      await sql.end();
    }
  });

  it("completes the masters data when an earlier start was cut short", async () => {
    await prepareClientDemo(env);
    const sql = postgres(url, { onnotice: () => {} });
    try {
      await sql`truncate organisation_documents, clients cascade`;
      await prepareClientDemo(env);
      const [clients] = await sql<{ n: number }[]>`select count(*)::int as n from clients`;
      expect(clients!.n).toBe(3);
    } finally {
      await sql.end();
    }
  });

  it("matches the Worker's own check of DEMO_PASSWORD (same usernames, same length limits)", () => {
    const workerUsernames: string[] = [...DEMO_USERNAMES];
    expect(workerUsernames).toEqual(DEMO_USERS.map((u) => u.username));
    const workerLimits: { min: number; max: number } = DEMO_PASSWORD_LENGTH;
    expect(workerLimits).toEqual({ min: MIN_LENGTH, max: MAX_LENGTH });
  });

  it("refuses to run anywhere but the client demo, or with a weak demo password", async () => {
    await expect(prepareClientDemo({ ...env, DEPLOYMENT: undefined })).rejects.toThrow(/only on the Cloudflare client demo/);
    await expect(prepareClientDemo({ ...env, DEMO_PASSWORD: "short" })).rejects.toThrow(/DEMO_PASSWORD.*At least 12 characters/);
    await expect(prepareClientDemo({ ...env, DEMO_PASSWORD: "the owner of everything" })).rejects.toThrow(/DEMO_PASSWORD.*username/);
    await expect(prepareClientDemo({ ...env, DATABASE_URL: undefined })).rejects.toThrow(/DATABASE_URL/);
  });
});
