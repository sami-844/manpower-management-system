import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { auditEvents, files, workerDocuments } from "../src/db/schema";
import { createTestApp, createWorker, ensureUser, signIn, type TestContext } from "./helpers";

// PRD 4.19 document masters; TR-ENG-15 registers; TR-SEC-12 uploads; TR-SEC-07 personal data;
// A26-A30. Fictional companies and numbers only (rule 11).

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => ctx.close());
beforeEach(async () => {
  await ctx.reset();
  // Sub-contractors from earlier tests would change the counts; the company's own sponsor row stays.
  await ctx.db.sql`TRUNCATE supply_rate_lines, supply_agreements RESTART IDENTITY CASCADE`;
  await ctx.db.sql`DELETE FROM sponsors WHERE kind = 'external'`;
});

const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

let crSeq = 0;
const cr = () => `CR-${Date.now().toString(36)}-${crSeq++}`;

const addClient = async (legalName = "Sohar Steel Works LLC", over: Record<string, unknown> = {}) => {
  const res = await ctx.api("ops.manager").post("/api/clients").send({ legalName, crNumber: cr(), vatNumber: "OM1100000001", ...over });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as { id: string; code: string };
};
const addSubcontractor = async (legalName = "Batinah Manpower LLC") => {
  const res = await ctx.api("hr.officer").post("/api/sponsors").send({ legalName, crNumber: cr(), molEstablishmentNo: "EST-9" });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body as { id: string };
};
const addOrgDoc = (subject: Record<string, unknown>, over: Record<string, unknown> = {}, as = "hr.officer") =>
  ctx.api(as).post("/api/organisation-documents").send({ subject, type: "commercial_registration", number: "1234567", expiryDate: "2028-01-31", ...over });
const master = (key: string, as = "hr.officer") => ctx.api(as).get(`/api/masters/${key}`);
const upload = (path: string, body: Buffer, type = "application/pdf", as = "hr.officer") =>
  ctx.api(as).post(path).set("content-type", type).set("x-file-name", encodeURIComponent("Scan – CR 2026.pdf")).send(body);

describe("the client register (A26)", () => {
  it("adds a client with a code from the sequence, and refuses a second client with the same CR", async () => {
    const res = await ctx.api("ops.manager").post("/api/clients").send({ legalName: "Majis Fabrication LLC", crNumber: "cr-777", paymentTermsDays: 45, creditLimit: "25000.500" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ legalName: "Majis Fabrication LLC", crNumber: "cr-777", paymentTermsDays: 45, creditLimit: "25000.500", status: "active" });
    expect(res.body.code).toMatch(/^C-\d{5}$/);
    const dup = await ctx.api("finance.officer").post("/api/clients").send({ legalName: "Other Name", crNumber: "CR-777" });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("CLIENT_EXISTS");
    const [event] = await ctx.db.base.select().from(auditEvents).where(eq(auditEvents.subjectId, res.body.id)).orderBy(asc(auditEvents.id));
    expect(event).toMatchObject({ action: "client.create", actor: "ops.manager" });
  });

  it("lets operations and finance change a client, and validates amounts as decimals", async () => {
    const c = await addClient();
    const moved = await ctx.api("finance.officer").patch(`/api/clients/${c.id}`).send({ status: "on_hold" });
    expect(moved.status).toBe(200);
    expect(moved.body.status).toBe("on_hold");
    expect((await ctx.api("ops.manager").patch(`/api/clients/${c.id}`).send({ creditLimit: 10.5 })).status).toBe(400);
    expect((await ctx.api("ops.manager").patch(`/api/clients/${c.id}`).send({})).status).toBe(400);
  });

  it("is read by HR, operations and finance, changed only by operations and finance", async () => {
    await addClient();
    expect((await ctx.api("hr.officer").get("/api/clients")).body.items).toHaveLength(1);
    expect((await ctx.api("hr.officer").post("/api/clients").send({ legalName: "Nope LLC" })).status).toBe(403);
    expect((await ctx.api("payroll.officer").get("/api/clients")).status).toBe(403);
  });
});

describe("organisation documents", () => {
  it("records the company's own papers against its own sponsor record", async () => {
    const res = await addOrgDoc({ kind: "company" }, { type: "tax_card", number: "TC-55" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: "tax_card", number: "TC-55", clientId: null, verified: false });
    const [own] = await ctx.db.sql<{ id: string }[]>`select id from sponsors where kind = 'own' and entity_id = 'OM-01'`;
    expect(res.body.sponsorId).toBe(own!.id);
  });

  it("refuses an unknown type, a client that does not exist, and the own company passed as a sub-contractor", async () => {
    expect((await addOrgDoc({ kind: "company" }, { type: "passport" })).status).toBe(400);
    expect((await addOrgDoc({ kind: "client", clientId: crypto.randomUUID() })).status).toBe(404);
    const [own] = await ctx.db.sql<{ id: string }[]>`select id from sponsors where kind = 'own' and entity_id = 'OM-01'`;
    const wrong = await addOrgDoc({ kind: "subcontractor", sponsorId: own!.id });
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe("NOT_A_SUBCONTRACTOR");
    expect((await addOrgDoc({ kind: "company" }, { issueDate: "2027-01-01", expiryDate: "2026-01-01" })).status).toBe(400);
  });

  it("lets only someone who may verify record a document as already verified", async () => {
    const byOps = await addOrgDoc({ kind: "company" }, { verified: true }, "ops.manager");
    expect(byOps.status).toBe(403);
    expect(byOps.body.code).toBe("VERIFY_NOT_ALLOWED");
    const byHr = await addOrgDoc({ kind: "company" }, { verified: true }, "hr.officer");
    expect(byHr.status).toBe(201);
    expect(byHr.body).toMatchObject({ verified: true, verifiedBy: "hr.officer" });
  });

  it("is recorded by HR/PRO and operations, verified by HR/PRO, and audited", async () => {
    expect((await addOrgDoc({ kind: "company" }, {}, "payroll.officer")).status).toBe(403);
    expect((await addOrgDoc({ kind: "company" }, {}, "finance.officer")).status).toBe(403);
    const doc = await addOrgDoc({ kind: "company" }, {}, "ops.manager");
    expect(doc.status).toBe(201);
    expect((await ctx.api("ops.manager").patch(`/api/organisation-documents/${doc.body.id}/verify`)).status).toBe(403);
    const verified = await ctx.api("hr.lead").patch(`/api/organisation-documents/${doc.body.id}/verify`);
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ verified: true, verifiedBy: "hr.lead" });
    const events = await ctx.db.base.select().from(auditEvents).where(eq(auditEvents.subjectId, doc.body.id)).orderBy(asc(auditEvents.id));
    expect(events.map((e) => e.action)).toEqual(["org_document.create", "org_document.verify"]);
  });
});

describe("the masters (TR-ENG-15)", () => {
  it("lists the eighteen masters in three groups, each with its counts", async () => {
    const res = await ctx.api("owner.gm").get("/api/masters");
    expect(res.status).toBe(200);
    expect(res.body.groups.map((g: { label: string; masters: unknown[] }) => [g.label, g.masters.length])).toEqual([
      ["In House", 12],
      ["Purchase", 5],
      ["Sales", 1],
    ]);
    const companyCr = res.body.groups[0].masters[0];
    expect(companyCr).toMatchObject({ no: 1, key: "company_registration", label: "Company registration certificate", requiredOfAll: true });
    // The company exists from the start, so its CR counts as missing until it is recorded.
    expect(companyCr.summary).toMatchObject({ total: 1, missing: 1 });
  });

  it("is seen by the owner, operations, HR/PRO and finance only", async () => {
    for (const who of ["owner.gm", "ops.manager", "hr.officer", "finance.officer"]) {
      expect((await ctx.api(who).get("/api/masters")).status).toBe(200);
    }
    expect((await ctx.api("payroll.officer").get("/api/masters")).status).toBe(403);
    expect((await ctx.api("sys.admin").get("/api/masters/tax_card")).status).toBe(403);
  });

  it("shows each company document's latest version and state, and counts what is missing", async () => {
    await addOrgDoc({ kind: "company" }, { type: "vat_certificate", expiryDate: "2026-10-01" }); // expired
    await addOrgDoc({ kind: "company" }, { type: "vat_certificate", expiryDate: "2027-09-30" }); // renewed
    await addOrgDoc({ kind: "company" }, { type: "tenancy_agreement", expiryDate: "2026-11-30" }); // due in 47 days
    const vat = await master("vat_certificate");
    expect(vat.status).toBe(200);
    expect(vat.body.rows).toEqual([
      expect.objectContaining({ state: "valid", daysLeft: 351, document: expect.objectContaining({ expiryDate: "2027-09-30" }) }),
    ]);
    const tenancy = await master("tenancy_agreement");
    expect(tenancy.body.rows[0]).toMatchObject({ state: "due", daysLeft: 47 });
    expect(tenancy.body.summary).toMatchObject({ total: 1, due: 1, missing: 0, unverified: 1 });
    expect((await master("municipality_licence")).body.summary).toMatchObject({ total: 1, missing: 1 });
  });

  it("covers active sub-contractors and every client, with their CR numbers shown in full", async () => {
    const sub = await addSubcontractor("Batinah Manpower LLC");
    await addSubcontractor("Ibri Labour Supply LLC");
    await addOrgDoc({ kind: "subcontractor", sponsorId: sub.id }, { number: "1098765", expiryDate: "2026-10-10" });
    const client = await addClient("Liwa Plastics Projects LLC");
    await addOrgDoc({ kind: "client", clientId: client.id }, { number: "1222333" }, "ops.manager");

    const subs = await master("subcontractor_registration");
    expect(subs.body.rows.map((r: { subject: { name: string }; state: string }) => [r.subject.name, r.state])).toEqual([
      ["Batinah Manpower LLC", "expired"],
      ["Ibri Labour Supply LLC", "missing"],
    ]);
    expect(subs.body.rows[0].document.number).toBe("1098765");
    const clientsMaster = await master("client_registration");
    expect(clientsMaster.body.rows).toEqual([
      expect.objectContaining({ subject: expect.objectContaining({ name: "Liwa Plastics Projects LLC", kind: "client" }), state: "valid" }),
    ]);
    // A client's paper is not the company's: the company CR is still missing.
    expect((await master("company_registration")).body.summary.missing).toBe(1);
  });

  it("files a worker's papers as direct or indirect by their engagement today, with numbers masked", async () => {
    const own = await createWorker(ctx, { fullName: "Direct Worker", joinedOn: "2026-01-01" });
    const sub = await addSubcontractor();
    const supplied = await createWorker(ctx, {
      fullName: "Indirect Worker",
      joinedOn: "2026-01-01",
      engagement: { engagement: "supplied", sponsorId: sub.id, authorisationRef: "MOL-A-1" },
    });

    const direct = await master("direct_passport");
    expect(direct.body.rows.map((r: { subject: { name: string } }) => r.subject.name)).toEqual(["Direct Worker"]);
    expect(direct.body.rows[0].document.number).toBe("••••4567");
    const indirect = await master("indirect_oman_id");
    expect(indirect.body.rows).toEqual([
      expect.objectContaining({
        state: "valid",
        subject: expect.objectContaining({ id: supplied.id, engagement: "supplied", sponsorName: "Batinah Manpower LLC" }),
        document: expect.objectContaining({ number: "••••5678" }),
      }),
    ]);

    // The worker becomes the company's own from today: their papers move to the direct masters.
    const moved = await ctx.api("hr.officer").post(`/api/workers/${supplied.id}/sponsorships`).send({ engagement: "own", validFrom: "2026-10-14" });
    expect(moved.status).toBe(201);
    expect((await master("direct_passport")).body.rows.map((r: { subject: { id: string } }) => r.subject.id).sort()).toEqual([own.id, supplied.id].sort());
    expect((await master("indirect_passport")).body.rows).toEqual([]);
  });

  it("counts a missing medical insurance but lists only the Sohar gate passes held", async () => {
    const w = await createWorker(ctx, { fullName: "No Insurance" }, [{ type: "passport", number: "P7654321", expiryDate: "2028-01-01" }]);
    await createWorker(ctx, { fullName: "Sohar Pass Holder" });
    const holder = (await ctx.api().get("/api/workers").query({ search: "Sohar Pass" })).body.items[0];
    await ctx.api().post(`/api/workers/${holder.id}/documents`).send({ type: "sohar_gate_pass", number: "SGP-1", expiryDate: "2027-03-31" });

    const insurance = await master("direct_medical_insurance");
    expect(insurance.body.rows.find((r: { subject: { id: string } }) => r.subject.id === w.id)).toMatchObject({ state: "missing", document: null });
    const passes = await master("direct_sohar_gate_pass");
    expect(passes.body.rows.map((r: { subject: { name: string } }) => r.subject.name)).toEqual(["Sohar Pass Holder"]);
    expect(passes.body.summary).toMatchObject({ total: 1, missing: 0 });
  });

  it("leaves out workers who cannot be rostered (exited, absconding, in recruitment)", async () => {
    await createWorker(ctx, { fullName: "Gone Worker", status: "exited" });
    await createWorker(ctx, { fullName: "Recruit", status: "in_recruitment" });
    expect((await master("direct_passport")).body.rows).toEqual([]);
  });

  it("answers 404 for a master that does not exist", async () => {
    const res = await master("passports");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("UNKNOWN_MASTER");
  });

  it("blocks rostering without an Oman ID card or medical insurance (A28)", async () => {
    const w = await createWorker(ctx, { fullName: "Missing ID" }, [
      { type: "passport", number: "P1", expiryDate: "2028-01-01" },
      { type: "residence_visa", number: "V1", expiryDate: "2028-01-01" },
      { type: "labour_card", number: "L1", expiryDate: "2028-01-01" },
      { type: "medical", expiryDate: "2028-01-01" },
    ]);
    const res = await ctx.api("ops.manager").post("/api/compliance/check").send({ workerId: w.id, from: "2026-11-01", to: "2026-11-30" });
    expect(res.body.eligible).toBe(false);
    expect(res.body.blockers.map((b: { documentType: string }) => b.documentType).sort()).toEqual(["civil_id", "medical_insurance"]);
  });
});

describe("scans (TR-SEC-12)", () => {
  it("stores a scan on a company document and opens it, audited, with safe headers", async () => {
    const doc = (await addOrgDoc({ kind: "company" })).body;
    const up = await upload(`/api/organisation-documents/${doc.id}/scan`, PDF);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ documentId: doc.id, mime: "application/pdf", bytes: PDF.length, scanStatus: "clean", originalName: "Scan – CR 2026.pdf" });

    const register = await master("company_registration");
    expect(register.body.rows[0].document).toMatchObject({ hasScan: true, scanStatus: "clean" });

    const open = await ctx.api("finance.officer").get(`/api/organisation-documents/${doc.id}/scan`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(open.status).toBe(200);
    expect(Buffer.compare(open.body as Buffer, PDF)).toBe(0);
    expect(open.headers["content-type"]).toBe("application/pdf");
    expect(open.headers["cache-control"]).toBe("no-store");
    expect(open.headers["x-content-type-options"]).toBe("nosniff");
    expect(open.headers["content-disposition"]).toContain("inline; filename*=UTF-8''");

    const events = await ctx.db.base.select().from(auditEvents).where(eq(auditEvents.subjectId, doc.id)).orderBy(asc(auditEvents.id));
    expect(events.map((e) => [e.action, e.actor])).toEqual([
      ["org_document.create", "hr.officer"],
      ["org_document.scan_attach", "hr.officer"],
      ["org_document.scan_open", "finance.officer"],
    ]);
  });

  it("un-verifies a verified document when someone who may not verify replaces its scan", async () => {
    const doc = (await addOrgDoc({ kind: "company" }, { verified: true })).body;
    const byOps = await upload(`/api/organisation-documents/${doc.id}/scan`, PDF, "application/pdf", "ops.manager");
    expect(byOps.status).toBe(201);
    expect(byOps.body.verified).toBe(false);
    const row = (await master("company_registration")).body.rows[0];
    expect(row.document).toMatchObject({ verified: false, verifiedBy: null, hasScan: true });
    // HR (who may verify) re-verifies, and replacing the scan themselves keeps it verified.
    await ctx.api("hr.lead").patch(`/api/organisation-documents/${doc.id}/verify`);
    const byHr = await upload(`/api/organisation-documents/${doc.id}/scan`, PNG, "image/png", "hr.lead");
    expect(byHr.body.verified).toBe(true);
  });

  it("keeps the old scan when a new one replaces it", async () => {
    const doc = (await addOrgDoc({ kind: "company" })).body;
    const first = await upload(`/api/organisation-documents/${doc.id}/scan`, PDF);
    const second = await upload(`/api/organisation-documents/${doc.id}/scan`, PNG, "image/png");
    expect(second.status).toBe(201);
    expect(second.body.fileId).not.toBe(first.body.fileId);
    expect(await ctx.db.base.select().from(files)).toHaveLength(2);
  });

  it("refuses a file that is not really the type it claims, an unknown type, and an empty body", async () => {
    const doc = (await addOrgDoc({ kind: "company" })).body;
    const path = `/api/organisation-documents/${doc.id}/scan`;
    const disguised = await upload(path, PNG, "application/pdf");
    expect(disguised.status).toBe(415);
    expect(disguised.body.code).toBe("UNSUPPORTED_FILE");
    expect((await upload(path, Buffer.from("MZ executable"), "application/octet-stream")).status).toBe(415);
    expect((await ctx.api().post(path).set("content-type", "application/pdf").send(Buffer.alloc(0))).status).toBe(415);
    expect(await ctx.db.base.select().from(files)).toHaveLength(0);
  });

  it("refuses an infected file and stores nothing", async () => {
    const doc = (await addOrgDoc({ kind: "company" })).body;
    const infected = await upload(`/api/organisation-documents/${doc.id}/scan`, Buffer.concat([PDF, Buffer.from(EICAR)]));
    expect(infected.status).toBe(422);
    expect(infected.body.code).toBe("FILE_INFECTED");
    expect(await ctx.db.base.select().from(files)).toHaveLength(0);
  });

  it("refuses a file over 15 MB in the API's JSON shape", async () => {
    const doc = (await addOrgDoc({ kind: "company" })).body;
    const big = Buffer.concat([PDF, Buffer.alloc(15 * 1024 * 1024)]);
    const res = await upload(`/api/organisation-documents/${doc.id}/scan`, big);
    expect(res.status).toBe(413);
    expect(res.body.code).toBe("FILE_TOO_LARGE");
  });

  it("never opens a file that has not been scanned clean", async () => {
    const doc = (await addOrgDoc({ kind: "company" })).body;
    const up = await upload(`/api/organisation-documents/${doc.id}/scan`, PDF);
    // As the production scanner would leave it until its verdict arrives (DEFERRED X15).
    await ctx.db.sql`update files set scan_status = 'pending' where id = ${up.body.fileId}`;
    const res = await ctx.api().get(`/api/organisation-documents/${doc.id}/scan`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("FILE_NOT_SCANNED");
    await ctx.db.sql`update files set scan_status = 'infected' where id = ${up.body.fileId}`;
    expect((await ctx.api().get(`/api/organisation-documents/${doc.id}/scan`)).body.code).toBe("FILE_INFECTED");
  });

  it("answers 404 when a document has no scan yet", async () => {
    const doc = (await addOrgDoc({ kind: "company" })).body;
    const res = await ctx.api().get(`/api/organisation-documents/${doc.id}/scan`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NO_SCAN");
  });

  it("opens a worker's passport scan only with the personal-data permission, and audits it (TR-SEC-07)", async () => {
    const w = await createWorker(ctx, { fullName: "Scanned Worker" });
    const [passport] = await ctx.db.base.select().from(workerDocuments).where(eq(workerDocuments.workerId, w.id));
    const up = await upload(`/api/documents/${passport!.id}/scan`, PDF);
    expect(up.status).toBe(201);
    expect((await upload(`/api/documents/${passport!.id}/scan`, PDF, "application/pdf", "ops.manager")).status).toBe(403);

    expect((await ctx.api("ops.manager").get(`/api/documents/${passport!.id}/scan`)).status).toBe(403);
    expect((await ctx.api("finance.officer").get(`/api/documents/${passport!.id}/scan`)).status).toBe(403);
    expect((await ctx.api("owner.gm").get(`/api/documents/${passport!.id}/scan`)).status).toBe(200);
    expect((await ctx.api("hr.lead").get(`/api/documents/${passport!.id}/scan`)).status).toBe(200);

    const events = await ctx.db.base.select().from(auditEvents).where(eq(auditEvents.subjectId, passport!.id)).orderBy(asc(auditEvents.id));
    expect(events.filter((e) => e.action === "document.scan_open").map((e) => e.actor)).toEqual(["owner.gm", "hr.lead"]);
    // The audit trail never holds the full number.
    const attach = events.find((e) => e.action === "document.scan_attach")!;
    expect(JSON.stringify(attach.after)).not.toContain("P1234567");
  });

  it("never lets the app rewrite a stored file's bytes record, only its scan status", async () => {
    const doc = (await addOrgDoc({ kind: "company" })).body;
    const up = await upload(`/api/organisation-documents/${doc.id}/scan`, PDF);
    const attempt = (async () =>
      ctx.db.sql.begin(async (tx) => {
        await tx`set local role mms_app`;
        await tx`select set_config('app.entity_id', 'OM-01', true)`;
        await tx`update files set sha256 = repeat('0', 64) where id = ${up.body.fileId}`;
      }))();
    await expect(attempt).rejects.toThrow(/permission denied/);
  });
});

describe("one company's masters are invisible to another (row-level security)", () => {
  it("shows another entity none of these clients, papers or scans", async () => {
    const client = await addClient("Oman-Only Client LLC");
    const doc = (await addOrgDoc({ kind: "client", clientId: client.id })).body;
    await upload(`/api/organisation-documents/${doc.id}/scan`, PDF);

    const uae = await ensureUser(ctx, `uae.ops.${Date.now().toString(36)}`, ["ops_manager", "hr_pro"], { entityId: "AE-01" });
    const { accessToken } = await signIn(ctx, uae);
    const as = { authorization: `Bearer ${accessToken}` };
    expect((await ctx.api(null).get("/api/clients").set(as)).body.items).toEqual([]);
    expect((await ctx.api(null).get("/api/masters/client_registration").set(as)).body.rows).toEqual([]);
    expect((await ctx.api(null).get(`/api/organisation-documents/${doc.id}/scan`).set(as)).status).toBe(404);
  });
});
