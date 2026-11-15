/**
 * Start-up of the Cloudflare client demo's API container (DECISIONS A32): fictional data only.
 * Each time the container starts (first request, and again after it wakes from idle) it applies any
 * new migrations, seeds the fictional workers and masters if the database is still empty (and completes
 * the masters if an earlier start was cut short), creates the six shared role accounts with the
 * deployer's DEMO_PASSWORD, and puts back any of them a visitor changed, then starts the API.
 * The image's own CMD (production on AWS) never runs this file; the demo Worker sets it as the entrypoint.
 */
import { and, count, eq, isNull } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { omanClock } from "../common/clock";
import { createDatabase, type Database } from "../db/client";
import { runMigrations } from "../db/migrate";
import { userRoles, userSessions, users, workers } from "../db/schema";
import { seedFictional, seedMasters } from "../db/seed";
import { DEMO_USERS, provisionUser } from "../auth/accounts";
import { publicUser } from "../auth/auth.service";
import { checkPasswordPolicy, hashPassword, verifyPassword } from "../auth/passwords";
import { CLIENT_DEMO } from "../files/files";

const BY = "system:client-demo";

export interface ClientDemoEnv {
  DEPLOYMENT?: string;
  DATABASE_URL?: string;
  DEMO_PASSWORD?: string;
  SEED_WORKERS?: string;
  ENTITY_ID?: string;
}

export async function prepareClientDemo(env: ClientDemoEnv): Promise<{ seeded: boolean; accountsCreated: string[]; accountsReset: string[] }> {
  if (env.DEPLOYMENT !== CLIENT_DEMO) {
    throw new Error(`This start-up runs only on the Cloudflare client demo (DEPLOYMENT=${CLIENT_DEMO}); production starts with the image's own command`);
  }
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required: the Postgres connection string pasted at deploy");
  const password = env.DEMO_PASSWORD ?? "";
  // Every demo account shares this password, so it must pass the policy for each of their usernames.
  const problems = [...new Set(DEMO_USERS.flatMap((u) => checkPasswordPolicy(password, u.username)))];
  if (problems.length) throw new Error(`DEMO_PASSWORD is not usable: ${problems.join("; ")}`);

  await runMigrations(env.DATABASE_URL);
  const db = createDatabase(env.DATABASE_URL);
  try {
    const [row] = await db.base.select({ n: count() }).from(workers);
    const seeded = (row?.n ?? 0) === 0;
    // seedMasters is idempotent: on later starts it completes masters data a start killed mid-seed left out.
    if (seeded) await seedFictional(db, omanClock.today(), Number(env.SEED_WORKERS ?? 120));
    else await seedMasters(db, omanClock.today());

    const entityId = env.ENTITY_ID ?? "OM-01";
    const accountsCreated: string[] = [];
    for (const u of DEMO_USERS) {
      const r = await provisionUser(db, { ...u, entityId, createdBy: BY }, password);
      if (r.created) accountsCreated.push(u.username);
    }
    const accountsReset = await resetDemoAccounts(db, password, entityId);
    return { seeded, accountsCreated, accountsReset };
  } finally {
    await db.sql.end();
  }
}

/**
 * The six accounts are shared by everyone the deployer gives DEMO_PASSWORD to, so one visitor must not
 * be able to lock the rest out for good: each start puts back the demo password (also when the deployer
 * changed the secret), turns two-factor off, lifts any lockout, re-enables the account, restores its role
 * and ends its sessions. Only accounts this start-up created are touched; each reset is audited.
 */
async function resetDemoAccounts(db: Database, password: string, entityId: string): Promise<string[]> {
  const audit = new AuditService(db);
  const reset: string[] = [];
  for (const u of DEMO_USERS) {
    const [user] = await db.base.select().from(users).where(and(eq(users.username, u.username), eq(users.createdBy, BY)));
    if (!user) continue;
    const roles = await db.base
      .select({ role: userRoles.roleKey })
      .from(userRoles)
      .where(and(eq(userRoles.userId, user.id), eq(userRoles.entityId, entityId), isNull(userRoles.revokedAt)));
    const missingRoles = u.roles.filter((r) => !roles.some((x) => x.role === r));
    const passwordKept = await verifyPassword(password, user.passwordHash);
    const intact =
      passwordKept &&
      user.totpSecretSealed === null &&
      user.totpPendingSealed === null &&
      user.failedSignIns === 0 &&
      user.lockedUntil === null &&
      user.status === "active" &&
      !user.isPasswordChangeRequired &&
      missingRoles.length === 0;
    if (intact) continue;
    const now = new Date();
    await db.base.transaction(async (tx) => {
      const [after] = await tx
        .update(users)
        .set({
          passwordHash: passwordKept ? user.passwordHash : await hashPassword(password),
          isPasswordChangeRequired: false,
          totpSecretSealed: null,
          totpPendingSealed: null,
          totpLastStep: null,
          failedSignIns: 0,
          lockedUntil: null,
          status: "active",
          updatedAt: now,
          updatedBy: BY,
        })
        .where(eq(users.id, user.id))
        .returning();
      if (missingRoles.length) {
        await tx.insert(userRoles).values(missingRoles.map((roleKey) => ({ userId: user.id, roleKey, entityId, validFrom: omanClock.today(), createdBy: BY })));
      }
      await tx
        .update(userSessions)
        .set({ revokedAt: now, revokeReason: "demo_reset" })
        .where(and(eq(userSessions.userId, user.id), isNull(userSessions.revokedAt)));
      await audit.record(tx, {
        actor: BY,
        action: "user.demo_reset",
        subjectType: "user",
        subjectId: user.id,
        before: { ...publicUser(user), roles: roles.map((x) => x.role) },
        after: { ...publicUser(after!), roles: u.roles },
        entityId,
      });
    });
    reset.push(u.username);
  }
  return reset;
}

if (import.meta.main) {
  try {
    const r = await prepareClientDemo(process.env as ClientDemoEnv);
    console.log(
      `Client demo ready: ${r.seeded ? "fictional data seeded" : "data kept"}; accounts created: ${r.accountsCreated.join(", ") || "none"}; accounts put back: ${r.accountsReset.join(", ") || "none"}`,
    );
  } catch (err) {
    // The Worker shows "starting" until the port opens; a clear line in the container log says why it never will.
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  await import("../main");
}
