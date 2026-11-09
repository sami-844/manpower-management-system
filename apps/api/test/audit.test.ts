import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createTestApp, createWorker, type TestContext } from "./helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => ctx.close());
beforeEach(async () => ctx.reset());

describe("audit trail (Spec §6)", () => {
  it("records who created a worker and what was saved", async () => {
    const w = await createWorker(ctx, { fullName: "Audit Me" }, []);
    const res = await ctx.api().get("/api/audit").query({ subjectId: w.id });
    // Creating a worker records the worker, then their engagement (own by default, PRD 4.18).
    expect(res.body.items).toEqual([
      expect.objectContaining({ actor: "hr.officer", action: "worker.create", before: null, after: expect.objectContaining({ fullName: "Audit Me" }) }),
      expect.objectContaining({ actor: "hr.officer", action: "worker.engagement", after: expect.objectContaining({ engagement: "own" }) }),
    ]);
  });

  it("records before and after when a document is verified", async () => {
    const w = await createWorker(ctx, {}, []);
    const doc = await ctx.api("pro").post(`/api/workers/${w.id}/documents`).send({ type: "medical", expiryDate: "2027-01-01" });
    await ctx.api("hr.lead").patch(`/api/documents/${doc.body.id}/verify`);
    const res = await ctx.api().get("/api/audit").query({ subjectId: doc.body.id });
    const verify = res.body.items.find((e: { action: string }) => e.action === "document.verify");
    expect(verify.before.verified).toBe(false);
    expect(verify.after.verified).toBe(true);
    expect(verify.actor).toBe("hr.lead");
  });

  it("keeps an intact hash chain", async () => {
    await createWorker(ctx);
    await createWorker(ctx);
    const res = await ctx.api("owner.gm").get("/api/audit/verify");
    expect(res.body).toMatchObject({ intact: true });
    expect(res.body.checked).toBeGreaterThan(0);
  });

  it("cannot be edited or deleted, even directly in the database", async () => {
    await createWorker(ctx, {}, []);
    // postgres.js queries are lazy: wrap them so they actually run (bun:test won't start them).
    await expect((async () => ctx.db.sql`UPDATE audit_events SET actor = 'someone-else'`)()).rejects.toThrow(/append-only/);
    await expect((async () => ctx.db.sql`DELETE FROM audit_events`)()).rejects.toThrow(/append-only/);
  });

  it("detects tampering if the chain is broken", async () => {
    // Simulate an attacker who bypasses the trigger to rewrite history.
    await createWorker(ctx, { fullName: "Original" }, []);
    await ctx.db.sql.begin(async (tx) => {
      await tx`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`;
      await tx`UPDATE audit_events SET actor = 'forged' WHERE id = (SELECT max(id) FROM audit_events)`;
      await tx`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`;
    });
    const res = await ctx.api("owner.gm").get("/api/audit/verify");
    expect(res.body.intact).toBe(false);
    expect(res.body.firstBrokenId).toBeTypeOf("number");
  });

  it("detects an event moved to another entity (hash version 2 covers the entity)", async () => {
    const w = await createWorker(ctx, { fullName: "Entity Bound" }, []);
    const [row] = await ctx.db.sql`select id, hash_version from audit_events where subject_id = ${w.id}`;
    expect(row!.hash_version).toBe(2);
    await ctx.db.sql.begin(async (tx) => {
      await tx`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update`;
      await tx`UPDATE audit_events SET entity_id = 'AE-01' WHERE id = ${row!.id}`;
      await tx`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update`;
    });
    const res = await ctx.api("owner.gm").get("/api/audit/verify");
    expect(res.body.intact).toBe(false);
  });
});
