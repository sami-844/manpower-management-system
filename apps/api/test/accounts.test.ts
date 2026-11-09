import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { provisionUser } from "../src/auth/accounts";
import { auditEvents, users } from "../src/db/schema";
import { createTestApp, type TestContext } from "./helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => ctx.close());

describe("provisioning accounts outside the API", () => {
  it("creates a user who must change the temporary password and set up 2FA, audited, once", async () => {
    const first = await provisionUser(ctx.db, { username: "Boot.Admin", displayName: "Boot", roles: ["admin"], entityId: "OM-01", createdBy: "system:bootstrap" });
    expect(first.created).toBe(true);
    expect(first.temporaryPassword).toHaveLength(16);
    const again = await provisionUser(ctx.db, { username: "boot.admin", displayName: "Boot", roles: ["admin"], entityId: "OM-01", createdBy: "system:bootstrap" });
    expect(again).toEqual({ created: false });

    const [u] = await ctx.db.base.select().from(users).where(eq(users.username, "boot.admin"));
    expect(u).toMatchObject({ isPasswordChangeRequired: true, totpSecretSealed: null, createdBy: "system:bootstrap" });
    const audit = await ctx.db.base.select().from(auditEvents).where(eq(auditEvents.subjectId, u!.id));
    expect(audit.map((a) => a.action)).toEqual(["user.create"]);

    const login = await ctx.api(null).post("/api/auth/login").send({ username: "boot.admin", password: first.temporaryPassword });
    expect(login.body.next).toBe("change_password");
  });
});
