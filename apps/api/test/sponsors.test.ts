import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createTestApp, createWorker, ensureUser, signIn, type TestContext } from "./helpers";

// PRD 4.18 sponsors and outsourced workers; A22 owner approval behind one setting; A24 four eyes.

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await ctx.reset();
  // Each test starts from the A22 default.
  await ctx.db.sql`update settings set value = '"allow_with_owner_approval"' where key = 'outsourcing.unauthorised'`;
});

const period = { from: "2026-11-01", to: "2026-11-30" };
let cr = 0;
const newSponsor = async (name = "Gulf Manpower LLC") => {
  const res = await ctx.api("hr.officer").post("/api/sponsors").send({ legalName: name, crNumber: `CR-${Date.now()}-${cr++}`, molEstablishmentNo: "EST-1" });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as { id: string };
};
const check = (workerId: string) => ctx.api("ops.manager").post("/api/compliance/check").send({ workerId, ...period });
const codes = (res: { body: { blockers: { code: string }[] } }) => res.body.blockers.map((b) => b.code);
/** The worker's current sponsorship, verified by a second person (hr.lead; createWorker records as hr.officer). */
const verifyCurrent = async (workerId: string, by = "hr.lead") => {
  const history = await ctx.api().get(`/api/workers/${workerId}/sponsorships`);
  return ctx.api(by).post(`/api/workers/${workerId}/sponsorships/${history.body.items[0].id}/verify-authorisation`);
};

describe("every worker has a sponsor and an engagement", () => {
  it("records a new worker as the company's own by default, shown on the list", async () => {
    const w = await createWorker(ctx, { fullName: "Own Worker" });
    const list = await ctx.api().get("/api/workers");
    const row = list.body.items.find((i: { id: string }) => i.id === w.id);
    expect(row.engagement).toMatchObject({ engagement: "own", isUnauthorised: false });
    expect(row.engagement.sponsorName).toBeString();
    expect((await check(w.id)).body.eligible).toBe(true);
  });

  it("counts workers per sponsor on one screen, unknown sponsors included", async () => {
    const s = await newSponsor("Counted Supply Co");
    const a = await createWorker(ctx, { fullName: "Worker A", engagement: { engagement: "supplied", sponsorId: s.id, authorisationRef: "MOL-2026-1" } });
    expect((await verifyCurrent(a.id)).status).toBe(200);
    await createWorker(ctx, { fullName: "Worker B", engagement: { engagement: "supplied", sponsorId: s.id } });
    await createWorker(ctx, { fullName: "Worker C", engagement: { engagement: "free_visa" } });
    await createWorker(ctx, { fullName: "Worker D" });
    const res = await ctx.api("owner.gm").get("/api/sponsors");
    expect(res.status).toBe(200);
    const mine = res.body.items.find((i: { id: string }) => i.id === s.id);
    expect(mine.workers).toMatchObject({ total: 2, unauthorised: 1, byEngagement: { supplied: 2 } });
    expect(res.body.items[0].kind).toBe("own");
    expect(res.body.items[0].workers.byEngagement.own).toBeGreaterThanOrEqual(1);
    expect(res.body.unknownSponsor).toMatchObject({ total: 1, unauthorised: 1, byEngagement: { free_visa: 1 } });
  });

  it("refuses a supplied worker without a sponsor, and a free-visa worker with an authorisation", async () => {
    const noSponsor = await ctx.api().post("/api/workers").send({ fullName: "X Y", nationality: "India", trade: "Mason", engagement: { engagement: "supplied" } });
    expect(noSponsor.body.code).toBe("SPONSOR_REQUIRED");
    const contradiction = await ctx
      .api()
      .post("/api/workers")
      .send({ fullName: "X Y", nationality: "India", trade: "Mason", engagement: { engagement: "free_visa", authorisationRef: "MOL-1" } });
    expect(contradiction.body.code).toBe("FREE_VISA_HAS_NO_AUTHORISATION");
  });

  it("keeps history: a change closes the previous record the day before, never rewrites it", async () => {
    const s = await newSponsor();
    const w = await createWorker(ctx, { fullName: "Changer", joinedOn: "2026-01-01" });
    const moved = await ctx
      .api("hr.officer")
      .post(`/api/workers/${w.id}/sponsorships`)
      .send({ engagement: "transferred", sponsorId: s.id, authorisationRef: "MOL-T-77", validFrom: "2026-11-15" });
    expect(moved.status).toBe(201);
    const history = await ctx.api().get(`/api/workers/${w.id}/sponsorships`);
    expect(history.body.items.map((h: { engagement: string; validFrom: string; validTo: string | null }) => [h.engagement, h.validFrom, h.validTo])).toEqual([
      ["transferred", "2026-11-15", null],
      ["own", "2026-01-01", "2026-11-14"],
    ]);
    const clash = await ctx.api("hr.officer").post(`/api/workers/${w.id}/sponsorships`).send({ engagement: "own", validFrom: "2026-11-15" });
    expect(clash.body.code).toBe("ENGAGEMENT_CONFLICT");
  });

  it("blocks days with no engagement at all, and no one can override that", async () => {
    const w = await createWorker(ctx, { fullName: "Late Joiner", joinedOn: "2026-11-10" });
    const res = await check(w.id);
    expect(codes(res)).toEqual(["NO_ENGAGEMENT"]);
  });
});

describe("unauthorised engagements (A22): the owner's approval, behind one setting", () => {
  it("lets a supplied worker with an authorisation work, and stops one without", async () => {
    const s = await newSponsor();
    const ok = await createWorker(ctx, { fullName: "Authorised", engagement: { engagement: "supplied", sponsorId: s.id, authorisationRef: "MOL-2026-9" } });
    const not = await createWorker(ctx, { fullName: "No paper", engagement: { engagement: "supplied", sponsorId: s.id } });
    // A typed reference is only a claim until a second person verifies it.
    expect(codes(await check(ok.id))).toEqual(["UNAUTHORISED_ENGAGEMENT"]);
    const self = await verifyCurrent(ok.id, "hr.officer");
    expect(self.body.code).toBe("FOUR_EYES");
    expect((await verifyCurrent(ok.id)).body).toMatchObject({ authorisationVerifiedBy: "hr.lead", isUnauthorised: false });
    expect((await check(ok.id)).body.eligible).toBe(true);
    expect((await verifyCurrent(not.id)).body.code).toBe("NO_AUTHORISATION");
    expect(codes(await check(not.id))).toEqual(["UNAUTHORISED_ENGAGEMENT"]);
  });

  it("only the owner can approve a free-visa worker; then the worker may be rostered", async () => {
    const w = await createWorker(ctx, { fullName: "Free Visa", engagement: { engagement: "free_visa" } });
    expect(codes(await check(w.id))).toEqual(["UNAUTHORISED_ENGAGEMENT"]);
    const body = { code: "UNAUTHORISED_ENGAGEMENT", validUntil: "2026-12-31", reason: "Client deadline, owner informed of the risk" };
    const byOps = await ctx.api("ops.manager").post(`/api/workers/${w.id}/overrides`).send(body);
    expect(byOps.status).toBe(403);
    expect(byOps.body.code).toBe("OWNER_APPROVAL_REQUIRED");
    const byOwner = await ctx.api("owner.gm").post(`/api/workers/${w.id}/overrides`).send(body);
    expect(byOwner.status).toBe(201);
    expect(byOwner.body.approvedBy).toBe("owner.gm");
    const res = await check(w.id);
    expect(res.body.eligible).toBe(true);
    expect(res.body.warnings).toContainEqual(expect.objectContaining({ code: "OVERRIDDEN", overriddenCode: "UNAUTHORISED_ENGAGEMENT" }));
  });

  it("with the setting on block, nothing lifts it and no override can be recorded", async () => {
    const w = await createWorker(ctx, { fullName: "Blocked", engagement: { engagement: "free_visa" } });
    const body = { code: "UNAUTHORISED_ENGAGEMENT", validUntil: "2026-12-31", reason: "Approved before the change" };
    expect((await ctx.api("owner.gm").post(`/api/workers/${w.id}/overrides`).send(body)).status).toBe(201);

    expect((await ctx.api("hr.officer").put("/api/settings/outsourcing").send({ unauthorised: "block" })).status).toBe(403);
    const set = await ctx.api("owner.gm").put("/api/settings/outsourcing").send({ unauthorised: "block" });
    expect(set.body).toEqual({ unauthorised: "block" });
    expect((await ctx.api("ops.manager").get("/api/settings/outsourcing")).body).toEqual({ unauthorised: "block" });

    expect(codes(await check(w.id))).toEqual(["UNAUTHORISED_ENGAGEMENT"]);
    const again = await ctx.api("owner.gm").post(`/api/workers/${w.id}/overrides`).send(body);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("POLICY_BLOCKS");
  });

  it("shows on the dashboard", async () => {
    await createWorker(ctx, { fullName: "Own" });
    await createWorker(ctx, { fullName: "FV", engagement: { engagement: "free_visa" } });
    const res = await ctx.api("owner.gm").get("/api/dashboard/summary");
    expect(res.body).toMatchObject({ byEngagement: { own: 1, free_visa: 1 }, unauthorised: 1 });
  });

  it("can be filtered on the workers list", async () => {
    await createWorker(ctx, { fullName: "Own" });
    await createWorker(ctx, { fullName: "FV", engagement: { engagement: "free_visa" } });
    const res = await ctx.api().get("/api/workers").query({ unauthorised: "true" });
    expect(res.body.items.map((w: { fullName: string }) => w.fullName)).toEqual(["FV"]);
  });
});

describe("supply agreements: four eyes, decimal money, locked once approved", () => {
  const draft = async (sponsorId: string, by = "ops.manager") =>
    ctx
      .api(by)
      .post("/api/supply-agreements")
      .send({ payee: "sponsor", sponsorId, reference: `SA-${Date.now()}`, startDate: "2026-11-01", inclusions: { accommodation: "sponsor", transport: "company" } });

  it("is recorded by one person and approved by another, only with rates", async () => {
    const s = await newSponsor();
    const a = await draft(s.id);
    expect(a.status).toBe(201);
    expect((await ctx.api("owner.gm").post(`/api/supply-agreements/${a.body.id}/approve`)).body.code).toBe("NO_RATES");

    const rate = (r: Record<string, unknown>) => ctx.api("ops.manager").post(`/api/supply-agreements/${a.body.id}/rates`).send(r);
    expect((await rate({ trade: "Mason", hourType: "normal", unit: "hour", rate: 1.25, validFrom: "2026-11-01" })).status).toBe(400);
    expect((await rate({ trade: "Mason", hourType: "normal", unit: "hour", rate: "1.2345", validFrom: "2026-11-01" })).status).toBe(400);
    const ok = await rate({ trade: "Mason", hourType: "normal", unit: "hour", rate: "1.25", validFrom: "2026-11-01" });
    expect(ok.body.rate).toBe("1.250");
    expect((await rate({ trade: "Mason", hourType: "normal", unit: "hour", rate: "1.300", validFrom: "2026-12-01" })).body.code).toBe("RATE_OVERLAPS");

    expect((await ctx.api("ops.manager").post(`/api/supply-agreements/${a.body.id}/approve`)).status).toBe(403);
    // Whoever added a rate cannot approve either, even holding supply.approve.
    await ctx.api("finance.officer").post(`/api/supply-agreements/${a.body.id}/rates`).send({ trade: "Welder", hourType: "night", unit: "hour", rate: "2.000", validFrom: "2026-11-01" });
    expect((await ctx.api("finance.officer").post(`/api/supply-agreements/${a.body.id}/approve`)).body.code).toBe("FOUR_EYES");
    const approved = await ctx.api("owner.gm").post(`/api/supply-agreements/${a.body.id}/approve`);
    expect(approved.body).toMatchObject({ status: "approved", approvedBy: "owner.gm" });
    expect((await rate({ trade: "Welder", hourType: "normal", unit: "day", rate: "12.000", validFrom: "2026-11-01" })).body.code).toBe("AGREEMENT_LOCKED");
  });

  it("refuses an approval by the person who recorded it", async () => {
    const s = await newSponsor();
    const a = await draft(s.id, "finance.officer");
    await ctx.api("finance.officer").post(`/api/supply-agreements/${a.body.id}/rates`).send({ trade: "Mason", hourType: "normal", unit: "hour", rate: "1.100", validFrom: "2026-11-01" });
    const self = await ctx.api("finance.officer").post(`/api/supply-agreements/${a.body.id}/approve`);
    expect(self.status).toBe(403);
    expect(self.body.code).toBe("FOUR_EYES");
  });

  it("links a supplied worker only to an approved agreement with the same sponsor", async () => {
    const s = await newSponsor();
    const other = await newSponsor("Other Sponsor LLC");
    const a = await draft(s.id);
    const w = await createWorker(ctx, { fullName: "Linked", joinedOn: "2026-10-01" });
    const link = (sponsorId: string) =>
      ctx
        .api("hr.officer")
        .post(`/api/workers/${w.id}/sponsorships`)
        .send({ engagement: "supplied", sponsorId, supplyAgreementId: a.body.id, authorisationRef: "MOL-5", validFrom: "2026-11-01" });
    expect((await link(s.id)).body.code).toBe("AGREEMENT_NOT_APPROVED");
    await ctx.api("ops.manager").post(`/api/supply-agreements/${a.body.id}/rates`).send({ trade: "Mason", hourType: "normal", unit: "hour", rate: "1.100", validFrom: "2026-11-01" });
    await ctx.api("owner.gm").post(`/api/supply-agreements/${a.body.id}/approve`);
    expect((await link(other.id)).body.code).toBe("AGREEMENT_OTHER_SPONSOR");
    expect((await link(s.id)).status).toBe(201);
  });

  it("pays a free-visa worker directly or through a middleman", async () => {
    const w = await createWorker(ctx, { fullName: "Direct Pay", engagement: { engagement: "free_visa" } });
    const direct = await ctx.api("ops.manager").post("/api/supply-agreements").send({ payee: "worker", workerId: w.id, reference: "FV-DIRECT", startDate: "2026-11-01" });
    expect(direct.status).toBe(201);
    const middleman = await ctx.api("ops.manager").post("/api/supply-agreements").send({ payee: "middleman", middlemanName: "Labour Agent", reference: "FV-MID", startDate: "2026-11-01" });
    expect(middleman.status).toBe(201);
    const list = await ctx.api("owner.gm").get("/api/supply-agreements");
    expect(list.body.items.map((a: { payeeName: string }) => a.payeeName)).toEqual(expect.arrayContaining(["Direct Pay", "Labour Agent"]));
  });
});

describe("sponsors belong to one company (row-level security)", () => {
  it("another entity sees none of this entity's sponsors", async () => {
    await newSponsor("Oman-Only Sponsor");
    const uae = await ensureUser(ctx, `uae.hr.${Date.now().toString(36)}`, ["hr_pro"], { entityId: "AE-01" });
    const { accessToken } = await signIn(ctx, uae);
    const res = await ctx.api(null).get("/api/sponsors").set({ authorization: `Bearer ${accessToken}` });
    expect(res.status).toBe(200);
    expect(res.body.items.map((s: { legalName: string }) => s.legalName)).not.toContain("Oman-Only Sponsor");
  });
});
