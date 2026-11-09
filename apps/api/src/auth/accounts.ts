/**
 * Creating accounts outside the API: the very first admin (`bun run auth:bootstrap-admin`) and the
 * fictional demo users (`bun run db:seed-users`). Each prints a temporary password once; the person
 * must replace it and set up an authenticator app at first sign-in. Every account creation is audited.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { AuditService } from "../audit/audit.service";
import { omanClock } from "../common/clock";
import { createDatabase, type Database } from "../db/client";
import { userRoles, users } from "../db/schema";
import { publicUser } from "./auth.service";
import { generateTemporaryPassword, hashPassword } from "./passwords";
import type { RoleKey } from "./permissions";

export async function provisionUser(
  db: Database,
  input: { username: string; displayName: string; roles: RoleKey[]; entityId: string; createdBy: string },
): Promise<{ created: boolean; temporaryPassword?: string }> {
  const username = input.username.toLowerCase();
  const [existing] = await db.base.select({ id: users.id }).from(users).where(eq(sql`lower(${users.username})`, username));
  if (existing) return { created: false };
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const audit = new AuditService(db);
  await db.base.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({ username, displayName: input.displayName, passwordHash, createdBy: input.createdBy, updatedBy: input.createdBy })
      .returning();
    await tx.insert(userRoles).values(
      input.roles.map((role) => ({ userId: user!.id, roleKey: role, entityId: input.entityId, validFrom: omanClock.today(), createdBy: input.createdBy })),
    );
    await audit.record(tx, {
      actor: input.createdBy,
      action: "user.create",
      subjectType: "user",
      subjectId: user!.id,
      before: null,
      after: { ...publicUser(user!), roles: input.roles, entityId: input.entityId },
      entityId: input.entityId,
    });
  });
  return { created: true, temporaryPassword };
}

async function hasActiveAdmin(db: Database): Promise<boolean> {
  const rows = await db.base
    .select({ id: userRoles.id })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.roleKey, "admin"), isNull(userRoles.revokedAt), eq(users.status, "active")))
    .limit(1);
  return rows.length > 0;
}

const DEMO_USERS: { username: string; displayName: string; roles: RoleKey[] }[] = [
  { username: "owner", displayName: "Owner (demo)", roles: ["owner"] },
  { username: "ops.manager", displayName: "Operations manager (demo)", roles: ["ops_manager"] },
  { username: "hr.officer", displayName: "HR / PRO officer (demo)", roles: ["hr_pro"] },
  { username: "payroll.officer", displayName: "Payroll officer (demo)", roles: ["payroll"] },
  { username: "finance.officer", displayName: "Finance officer (demo)", roles: ["finance"] },
  { username: "admin", displayName: "System admin (demo)", roles: ["admin"] },
];

async function main(command: string | undefined) {
  const url = process.env.DATABASE_URL ?? "postgres://mms:mms@localhost:5432/mms_dev";
  const entityId = process.env.ENTITY_ID ?? "OM-01";
  const db = createDatabase(url);
  try {
    if (command === "bootstrap-admin") {
      const username = process.argv[3] ?? "admin";
      if (await hasActiveAdmin(db)) {
        console.error("An active admin already exists. Create further accounts from Admin › Users.");
        process.exitCode = 1;
        return;
      }
      const r = await provisionUser(db, { username, displayName: "System admin", roles: ["admin"], entityId, createdBy: "system:bootstrap" });
      if (!r.created) {
        console.error(`"${username}" exists but is not an active admin; choose another username.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Admin "${username}" created. Temporary password (shown once): ${r.temporaryPassword}`);
    } else if (command === "seed-users") {
      if (url.includes("prod")) throw new Error("Refusing to seed demo users into a production database");
      for (const u of DEMO_USERS) {
        const r = await provisionUser(db, { ...u, entityId, createdBy: "system:seed" });
        console.log(r.created ? `${u.username.padEnd(16)} ${r.temporaryPassword}` : `${u.username.padEnd(16)} (already exists, unchanged)`);
      }
      console.log("Each person changes the temporary password and sets up an authenticator app at first sign-in.");
    } else {
      console.error("Usage: accounts.ts bootstrap-admin [username] | seed-users");
      process.exitCode = 1;
    }
  } finally {
    await db.sql.end();
  }
}

if (import.meta.main) {
  main(process.argv[2]).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
