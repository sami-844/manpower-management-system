/**
 * Browser-test accounts (CI and local dev only): one HR officer per Playwright project, with the
 * temporary password already replaced and an authenticator already enrolled, so the journeys sign
 * in through the real screen with a live code. Idempotent. Refuses a production database.
 *
 *   E2E_PASSWORD / E2E_TOTP_SECRET override the development defaults below (CI may set its own).
 */
import { eq } from "drizzle-orm";
import { loadAuthConfig } from "../src/auth/config";
import { seal } from "../src/auth/crypto";
import { hashPassword } from "../src/auth/passwords";
import { createDatabase } from "../src/db/client";
import { userRoles, users } from "../src/db/schema";

export const E2E_USERS = ["e2e.hr.desktop", "e2e.hr.phone"];
export const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "e2e-only-password-not-a-secret";
export const E2E_TOTP_SECRET = process.env.E2E_TOTP_SECRET ?? "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

async function main() {
  const url = process.env.DATABASE_URL ?? "postgres://mms:mms@localhost:5432/mms_dev";
  if (url.includes("prod") || process.env.NODE_ENV === "production") throw new Error("Refusing to create test accounts in production");
  const config = loadAuthConfig();
  const db = createDatabase(url);
  try {
    for (const username of E2E_USERS) {
      const [existing] = await db.base.select({ id: users.id }).from(users).where(eq(users.username, username));
      if (existing) {
        console.log(`${username} exists`);
        continue;
      }
      const [user] = await db.base
        .insert(users)
        .values({
          username,
          displayName: `Browser test (${username.split(".").pop()})`,
          passwordHash: await hashPassword(E2E_PASSWORD),
          isPasswordChangeRequired: false,
          totpSecretSealed: seal(E2E_TOTP_SECRET, config.sealKey),
          createdBy: "system:e2e",
          updatedBy: "system:e2e",
        })
        .returning();
      await db.base.insert(userRoles).values({ userId: user!.id, roleKey: "hr_pro", entityId: "OM-01", validFrom: "2026-01-01", createdBy: "system:e2e" });
      console.log(`${username} created`);
    }
  } finally {
    await db.sql.end();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
