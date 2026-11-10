import { describe, expect, it } from "vitest";
import type { EligibilityResult } from "@mms/core";
import { ApiError, type DashboardSummary, type RenewalItem, type WorkerDetail, type WorkerListItem } from "@/lib/api";
import { createDemoServer } from "./server";

const TODAY = "2026-11-09";
type List = { total: number; items: WorkerListItem[] };

describe("hosted demo API (browser stand-in for apps/api)", () => {
  it("seeds the same 680 fictional workers every time, sorted by name, coded from a counter", async () => {
    const a = await createDemoServer(TODAY).handle<List>("GET", "/api/workers?limit=500", undefined, "hr.officer");
    const b = await createDemoServer(TODAY).handle<List>("GET", "/api/workers?limit=500", undefined, "hr.officer");
    expect(a.total).toBe(680);
    expect(a.items).toHaveLength(500);
    expect(a.items).toEqual(b.items);
    const names = a.items.map((w) => w.fullName);
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)));
    expect(a.items.every((w) => /^W-\d{6}$/.test(w.code))).toBe(true);
  });

  it("filters by search, status and paper state, and pages", async () => {
    const s = createDemoServer(TODAY);
    const one = await s.handle<List>("GET", "/api/workers?search=W-000007", undefined, "x");
    expect(one.items.map((w) => w.code)).toEqual(["W-000007"]);
    const expired = await s.handle<List>("GET", "/api/workers?compliance=expired&limit=500", undefined, "x");
    expect(expired.total).toBeGreaterThan(0);
    expect(expired.items.every((w) => w.compliance.state === "expired")).toBe(true);
    const bench = await s.handle<List>("GET", "/api/workers?status=available&limit=500", undefined, "x");
    expect(bench.items.every((w) => w.status === "available")).toBe(true);
    const page2 = await s.handle<List>("GET", "/api/workers?limit=10&offset=10", undefined, "x");
    const all = await s.handle<List>("GET", "/api/workers?limit=20", undefined, "x");
    expect(page2.items).toEqual(all.items.slice(10, 20));
  });

  it("adds a worker, refuses deployment without papers, then clears once papers are in", async () => {
    const s = createDemoServer(TODAY);
    const created = await s.handle<{ id: string; code: string }>(
      "POST", "/api/workers", { fullName: "Demo Worker", nationality: "Nepal", trade: "Scaffolder" }, "hr.officer");
    expect(created.code).toBe("W-000681");

    const check = () => s.handle<EligibilityResult>("POST", "/api/compliance/check", { workerId: created.id, from: TODAY, to: TODAY }, "hr.officer");
    const before = await check();
    expect(before.eligible).toBe(false);
    expect(before.blockers.some((b) => b.code === "MISSING_DOCUMENT" && b.documentType === "passport")).toBe(true);

    // A28: the mandatory set is passport, residence visa, labour card, medical, Oman ID card and medical insurance.
    const papers = ["passport", "residence_visa", "labour_card", "medical", "civil_id", "medical_insurance"];
    for (const type of papers.slice(0, -1)) {
      await s.handle("POST", `/api/workers/${created.id}/documents`, { type, number: "AB1234567", expiryDate: "2028-06-30", verified: true }, "hr.officer");
    }
    expect((await check()).blockers.map((b) => b.documentType)).toEqual(["medical_insurance"]); // one paper short still blocks
    for (const type of papers.slice(-1)) {
      await s.handle("POST", `/api/workers/${created.id}/documents`, { type, number: "AB1234567", expiryDate: "2028-06-30", verified: true }, "hr.officer");
    }
    expect((await check()).eligible).toBe(true);

    const detail = await s.handle<WorkerDetail>("GET", `/api/workers/${created.id}`, undefined, "hr.officer");
    expect(detail.compliance.state).toBe("ok");
    expect(detail.documents).toHaveLength(6);
    expect(detail.documents.every((d) => d.number === "••••4567")).toBe(true); // rule 10: last 4 only
  });

  it("answers bad input and unknown records the way the API does", async () => {
    const s = createDemoServer(TODAY);
    const bad = await s.handle("POST", "/api/workers", { fullName: "A" }, "x").catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(ApiError);
    expect((bad as ApiError).status).toBe(400);
    expect((bad as ApiError).issues.map((i) => i.path)).toEqual(expect.arrayContaining(["fullName", "nationality", "trade"]));

    const missing = await s.handle("GET", "/api/workers/00000000-0000-4000-8000-ffffffffffff", undefined, "x").catch((e: unknown) => e);
    expect((missing as ApiError).status).toBe(404);

    const unknownRoute = await s.handle("GET", "/api/nothing", undefined, "x").catch((e: unknown) => e);
    expect((unknownRoute as ApiError).status).toBe(404);
  });

  it("records every change in an intact hash chain, and refuses overrides that end in the past", async () => {
    const s = createDemoServer(TODAY);
    const { items } = await s.handle<List>("GET", "/api/workers?limit=1", undefined, "x");
    const worker = items[0]!;
    const past = await s
      .handle("POST", `/api/workers/${worker.id}/overrides`, { code: "MISSING_DOCUMENT", documentType: "medical", validUntil: "2026-01-01", reason: "Clinic booked" }, "ops.manager")
      .catch((e: unknown) => e);
    expect((past as ApiError).status).toBe(400);

    await s.handle("POST", `/api/workers/${worker.id}/overrides`, { code: "MISSING_DOCUMENT", documentType: "medical", validUntil: "2026-12-01", reason: "Clinic booked" }, "ops.manager");
    await s.handle("POST", `/api/workers/${worker.id}/leave`, { fromDate: "2026-12-10", toDate: "2026-12-20" }, "hr.officer");

    const audit = await s.handle<{ items: { action: string; actor: string }[] }>("GET", `/api/audit?subjectId=${worker.id}`, undefined, "x");
    expect(audit.items.map((e) => e.action)).toEqual(["compliance.override"]);
    expect(audit.items[0]!.actor).toBe("ops.manager");
    expect(await s.handle("GET", "/api/audit/verify", undefined, "x")).toEqual({ intact: true, checked: 2, firstBrokenId: null });
  });

  it("builds renewals and the dashboard summary from the same rule engines", async () => {
    const s = createDemoServer(TODAY);
    const { items } = await s.handle<{ items: RenewalItem[] }>("GET", "/api/compliance/renewals", undefined, "x");
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((r) => r.workerCode && r.workerName && r.expiryDate)).toBe(true);

    const sum = await s.handle<DashboardSummary>("GET", "/api/dashboard/summary", undefined, "x");
    expect(sum.today).toBe(TODAY);
    expect(sum.headcount).toBe(680);
    expect(Object.values(sum.byCompliance).reduce((a, b) => a + b, 0)).toBe(680);
    expect(Object.values(sum.byStatus).reduce((a, b) => a + b, 0)).toBe(680);

    const sites = await s.handle<{ items: { code: string }[] }>("GET", "/api/sites", undefined, "x");
    expect(sites.items.map((x) => x.code).sort()).toEqual(["MCT-TWR", "SOH-IND", "SOH-PORT"]);
  });

  describe("document masters (S-44, S-45)", () => {
    type Overview = { groups: { group: string; masters: { no: number; key: string; summary: Record<string, number> }[] }[] };
    type Register = {
      master: { no: number; key: string };
      summary: Record<string, number>;
      rows: {
        subject: { id: string; name: string; engagement: string | null; sponsorName: string | null };
        document: { id: string; number: string | null; verified: boolean; verifiedBy: string | null; hasScan: boolean; scanStatus: string | null } | null;
        state: string;
      }[];
    };
    const PDF = new TextEncoder().encode("%PDF-1.4 fictional scan");
    const pdf = { bytes: PDF, contentType: "application/pdf", fileName: encodeURIComponent("cr scan.png") };
    const fail = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as ApiError);

    it("lists the eighteen masters in three groups, counted from the seed", async () => {
      const s = createDemoServer(TODAY);
      const o = await s.handle<Overview>("GET", "/api/masters", undefined, "owner.gm");
      expect(o.groups.map((g) => g.group)).toEqual(["in_house", "purchase", "sales"]);
      const all = o.groups.flatMap((g) => g.masters);
      expect(all.map((m) => m.no)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
      const by = (key: string) => all.find((m) => m.key === key)!.summary;
      expect(by("activity_licence")).toMatchObject({ total: 1, expired: 1 });
      expect(by("chamber_certificate")).toMatchObject({ total: 1, due: 1 });
      expect(by("subcontractor_registration")).toMatchObject({ total: 2, missing: 0 });
      expect(by("client_registration")).toMatchObject({ total: 3, missing: 1 }); // Batinah Steel has no CR yet
      expect(by("indirect_passport").total).toBe(43); // every sixteenth of 680 workers
      expect(by("direct_passport").total).toBe(637);
      expect(by("direct_medical_insurance").missing).toBeGreaterThan(0);
      expect(by("direct_sohar_gate_pass").missing).toBe(0); // holders only
      expect(by("direct_sohar_gate_pass").total).toBeGreaterThan(0);
    });

    it("opens one register, most urgent first, with worker numbers masked and sponsors named", async () => {
      const s = createDemoServer(TODAY);
      const r = await s.handle<Register>("GET", "/api/masters/indirect_oman_id", undefined, "hr.officer");
      expect(r.master.no).toBe(15);
      expect(r.rows.every((x) => x.subject.engagement === "supplied" && x.subject.sponsorName?.endsWith("LLC"))).toBe(true);
      expect(r.rows.every((x) => x.document?.number?.startsWith("••••"))).toBe(true);
      const urgency = ["expired", "missing", "no_expiry", "due", "valid"];
      const order = r.rows.map((x) => urgency.indexOf(x.state));
      expect(order).toEqual([...order].sort((a, b) => a - b));

      expect(await fail(s.handle("GET", "/api/masters/nothing", undefined, "hr.officer"))).toMatchObject({ status: 404, code: "UNKNOWN_MASTER" });
    });

    it("adds a client, then records its CR; refuses a duplicate CR", async () => {
      const s = createDemoServer(TODAY);
      const client = await s.handle<{ id: string; code: string }>("POST", "/api/clients", { legalName: "Coastal Works LLC", crNumber: "3999001" }, "finance.lead");
      expect(client.code).toBe("C-00004");
      expect(await fail(s.handle("POST", "/api/clients", { legalName: "Copy LLC", crNumber: "3999001" }, "finance.lead"))).toMatchObject({ status: 409, code: "CLIENT_EXISTS" });
      const listed = await s.handle<{ items: { legalName: string }[] }>("GET", "/api/clients", undefined, "x");
      expect(listed.items.map((c) => c.legalName)).toContain("Coastal Works LLC");

      let reg = await s.handle<Register>("GET", "/api/masters/client_registration", undefined, "ops.manager");
      expect(reg.rows.find((x) => x.subject.id === client.id)?.state).toBe("missing");
      await s.handle("POST", "/api/organisation-documents", { subject: { kind: "client", clientId: client.id }, type: "commercial_registration", number: "3999001", expiryDate: "2028-01-31" }, "ops.manager");
      reg = await s.handle<Register>("GET", "/api/masters/client_registration", undefined, "ops.manager");
      expect(reg.rows.find((x) => x.subject.id === client.id)).toMatchObject({ state: "valid", document: { number: "3999001", verified: false } });
    });

    it("adds a sub-contractor to master 13", async () => {
      const s = createDemoServer(TODAY);
      await s.handle("POST", "/api/sponsors", { legalName: "Sur Manpower LLC", crNumber: "2999001" }, "ops.manager");
      const reg = await s.handle<Register>("GET", "/api/masters/subcontractor_registration", undefined, "ops.manager");
      expect(reg.rows.find((x) => x.subject.name === "Sur Manpower LLC")?.state).toBe("missing");
      expect(await fail(s.handle("POST", "/api/sponsors", { legalName: "Copy", crNumber: "2999001" }, "ops.manager"))).toMatchObject({ status: 409, code: "SPONSOR_EXISTS" });
    });

    it("keeps the company's own papers to HR, and recording as verified to those who may verify", async () => {
      const s = createDemoServer(TODAY);
      const company = { subject: { kind: "company" }, type: "tax_card", number: "TAX-1", expiryDate: "2028-01-31" };
      expect(await fail(s.handle("POST", "/api/organisation-documents", company, "ops.manager"))).toMatchObject({ status: 403, code: "COMPANY_DOCUMENTS_HR_ONLY" });
      await s.handle("POST", "/api/organisation-documents", company, "hr.officer");

      const { items } = await s.handle<{ items: { id: string }[] }>("GET", "/api/clients", undefined, "x");
      const verified = { subject: { kind: "client", clientId: items[0]!.id }, type: "vat_certificate", verified: true };
      expect(await fail(s.handle("POST", "/api/organisation-documents", verified, "ops.manager"))).toMatchObject({ status: 403, code: "VERIFY_NOT_ALLOWED" });
      const { items: workers } = await s.handle<List>("GET", "/api/workers?limit=1", undefined, "x");
      expect(await fail(s.handle("POST", `/api/workers/${workers[0]!.id}/documents`, { type: "insurance", verified: true }, "ops.manager"))).toMatchObject({ status: 403, code: "VERIFY_NOT_ALLOWED" });
    });

    it("keeps a scan for the visit, opens it again, and un-verifies on a scan from someone who may not verify", async () => {
      const s = createDemoServer(TODAY);
      const doc = (await s.handle<Register>("GET", "/api/masters/tax_card", undefined, "hr.officer")).rows[0]!.document!;
      expect(await fail(s.handle("POST", `/api/organisation-documents/${doc.id}/scan`, pdf, "ops.manager"))).toMatchObject({ status: 403, code: "COMPANY_DOCUMENTS_HR_ONLY" });
      expect(await fail(s.handle("GET", `/api/organisation-documents/${doc.id}/scan`, undefined, "hr.officer"))).toMatchObject({ status: 404, code: "NO_SCAN" });

      const up = await s.handle<{ verified: boolean; originalName: string }>("POST", `/api/organisation-documents/${doc.id}/scan`, pdf, "hr.officer");
      expect(up).toMatchObject({ verified: true, originalName: "cr scan.png.pdf" }); // HR keeps it verified; the name ends in the real type
      const opened = await s.handle<{ bytes: Uint8Array; mime: string }>("GET", `/api/organisation-documents/${doc.id}/scan`, undefined, "owner.gm");
      expect(opened.mime).toBe("application/pdf");
      expect([...opened.bytes]).toEqual([...PDF]);
      const after = await s.handle<Register>("GET", "/api/masters/tax_card", undefined, "hr.officer");
      expect(after.rows[0]!.document).toMatchObject({ hasScan: true, scanStatus: "clean", verified: true });
      // Verifying twice is refused: the first verifier stays.
      expect(await fail(s.handle("PATCH", `/api/organisation-documents/${doc.id}/verify`, undefined, "hr.officer"))).toMatchObject({ status: 409, code: "ALREADY_VERIFIED" });

      const clientDoc = (await s.handle<Register>("GET", "/api/masters/client_registration", undefined, "ops.manager")).rows.find((r) => r.document?.verified)!.document!;
      expect((await s.handle<{ verified: boolean }>("POST", `/api/organisation-documents/${clientDoc.id}/scan`, pdf, "ops.manager")).verified).toBe(false);
      const reg = await s.handle<Register>("GET", "/api/masters/client_registration", undefined, "ops.manager");
      expect(reg.rows.find((r) => r.document?.id === clientDoc.id)!.document).toMatchObject({ verified: false, verifiedBy: null });

      const worker = (await s.handle<Register>("GET", "/api/masters/direct_passport", undefined, "hr.officer")).rows[0]!.document!;
      await s.handle("POST", `/api/documents/${worker.id}/scan`, pdf, "hr.officer");
      expect((await s.handle<{ mime: string }>("GET", `/api/documents/${worker.id}/scan`, undefined, "hr.officer")).mime).toBe("application/pdf");
      const audit = await s.handle<{ items: { action: string }[] }>("GET", `/api/audit?subjectId=${worker.id}`, undefined, "x");
      expect(audit.items.map((e) => e.action)).toEqual(["document.scan_attach", "document.scan_open"]);
    });

    it("refuses a scan that is not really a PDF, JPG, PNG or HEIC, or is over 15 MB", async () => {
      const s = createDemoServer(TODAY);
      const doc = (await s.handle<Register>("GET", "/api/masters/tax_card", undefined, "hr.officer")).rows[0]!.document!;
      const path = `/api/organisation-documents/${doc.id}/scan`;
      const text = { bytes: new TextEncoder().encode("not a scan"), contentType: "application/pdf", fileName: "x.pdf" };
      expect(await fail(s.handle("POST", path, text, "hr.officer"))).toMatchObject({ status: 415, code: "UNSUPPORTED_FILE" });
      expect(await fail(s.handle("POST", path, { ...pdf, contentType: "image/png" }, "hr.officer"))).toMatchObject({ status: 415, code: "UNSUPPORTED_FILE" });
      const big = new Uint8Array(15 * 1024 * 1024 + 1);
      big.set(PDF);
      expect(await fail(s.handle("POST", path, { ...pdf, bytes: big }, "hr.officer"))).toMatchObject({ status: 413, code: "FILE_TOO_LARGE" });
    });
  });
});
