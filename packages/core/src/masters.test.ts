import { describe, expect, it } from "vitest";
import {
  buildMasterRegister,
  engagementSubject,
  MASTERS,
  masterByKey,
  masterDocumentLabel,
  ORGANISATION_DOCUMENT_TYPES,
  organisationDocumentLabel,
  summariseMaster,
  type MasterDefinition,
} from "./masters";

// PRD 4.19 and TR-ENG-15 — eighteen document masters in three groups; each shows, for every
// company or worker it covers, the document with the latest expiry and its state on the day.

describe("the master catalogue", () => {
  it("has the eighteen masters in the client's order and groups", () => {
    expect(MASTERS.map((m) => [m.no, m.group, m.label])).toEqual([
      [1, "in_house", "Company registration certificate"],
      [2, "in_house", "Chamber of Commerce & Industry certificate"],
      [3, "in_house", "Tax card"],
      [4, "in_house", "VAT certificate"],
      [5, "in_house", "Activity licence"],
      [6, "in_house", "Tenancy agreement"],
      [7, "in_house", "Municipality licence"],
      [8, "in_house", "Labour authorisation"],
      [9, "in_house", "Direct employee passport"],
      [10, "in_house", "Direct employee Oman ID card"],
      [11, "in_house", "Direct employee medical insurance"],
      [12, "in_house", "Direct employee Sohar gate pass"],
      [13, "purchase", "Sub-contractor company registration certificate"],
      [14, "purchase", "Indirect employee passport"],
      [15, "purchase", "Indirect employee Oman ID card"],
      [16, "purchase", "Indirect employee medical insurance"],
      [17, "purchase", "Indirect employee Sohar gate pass"],
      [18, "sales", "Client company registration certificate"],
    ]);
  });

  it("gives every master a unique key and the right subject and document type", () => {
    expect(new Set(MASTERS.map((m) => m.key)).size).toBe(18);
    const at = (no: number) => MASTERS[no - 1]!;
    expect(MASTERS.slice(0, 8).map((m) => [m.subject, m.documentType])).toEqual(
      ORGANISATION_DOCUMENT_TYPES.map((t) => ["company", t]),
    );
    expect([at(9), at(10), at(11), at(12)].map((m) => [m.subject, m.documentType])).toEqual([
      ["direct_employee", "passport"],
      ["direct_employee", "civil_id"],
      ["direct_employee", "medical_insurance"],
      ["direct_employee", "sohar_gate_pass"],
    ]);
    expect([at(14), at(15), at(16), at(17)].map((m) => [m.subject, m.documentType])).toEqual([
      ["indirect_employee", "passport"],
      ["indirect_employee", "civil_id"],
      ["indirect_employee", "medical_insurance"],
      ["indirect_employee", "sohar_gate_pass"],
    ]);
    expect([at(13).subject, at(13).documentType]).toEqual(["subcontractor", "commercial_registration"]);
    expect([at(18).subject, at(18).documentType]).toEqual(["client", "commercial_registration"]);
  });

  it("counts a missing document everywhere except the Sohar gate pass, which only some sites require", () => {
    expect(MASTERS.filter((m) => !m.requiredOfAll).map((m) => m.no)).toEqual([12, 17]);
  });

  it("finds a master by key, and nothing for an unknown key", () => {
    expect(masterByKey("direct_passport")?.no).toBe(9);
    expect(masterByKey("client_registration")?.no).toBe(18);
    expect(masterByKey("nope")).toBeUndefined();
  });

  it("labels organisation and worker document types", () => {
    expect(ORGANISATION_DOCUMENT_TYPES.map(organisationDocumentLabel)).toEqual([
      "Company registration certificate",
      "Chamber of Commerce & Industry certificate",
      "Tax card",
      "VAT certificate",
      "Activity licence",
      "Tenancy agreement",
      "Municipality licence",
      "Labour authorisation",
    ]);
    expect(masterDocumentLabel(masterByKey("indirect_oman_id")!)).toBe("Oman ID card");
    expect(masterDocumentLabel(masterByKey("tax_card")!)).toBe("Tax card");
  });

  it("files own workers as direct employees and every other engagement as indirect", () => {
    expect(engagementSubject("own")).toBe("direct_employee");
    expect(engagementSubject("supplied")).toBe("indirect_employee");
    expect(engagementSubject("transferred")).toBe("indirect_employee");
    expect(engagementSubject("free_visa")).toBe("indirect_employee");
  });
});

describe("buildMasterRegister", () => {
  const today = "2026-10-14";
  const passport = masterByKey("direct_passport")!;
  const gatePass = masterByKey("direct_sohar_gate_pass")!;
  const subjects = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
  const doc = (subjectId: string, expiryDate: string | null, over: Partial<{ type: string; verified: boolean }> = {}) => ({
    subjectId,
    type: "passport",
    expiryDate,
    verified: true,
    ...over,
  });

  it("shows each subject's latest document and its state, most urgent first", () => {
    const rows = buildMasterRegister(
      passport,
      subjects,
      [
        doc("a", "2030-01-01"),
        doc("b", "2026-10-01"), // expired 13 days ago…
        doc("b", "2026-12-01"), // …but renewed: the latest expiry counts (due in 48 days)
        doc("c", "2026-10-10"),
        doc("d", null),
        doc("e", "2030-01-01", { type: "civil_id" }), // another master's document
      ],
      today,
    );
    expect(rows.map((r) => [r.subject.id, r.state, r.daysLeft])).toEqual([
      ["c", "expired", -4],
      ["e", "missing", null],
      ["d", "no_expiry", null],
      ["b", "due", 48],
      ["a", "valid", 1175],
    ]);
    expect(rows.find((r) => r.subject.id === "b")?.document?.expiryDate).toBe("2026-12-01");
    expect(rows.find((r) => r.subject.id === "e")?.document).toBeNull();
  });

  it("orders several expired documents by how long ago they expired", () => {
    const rows = buildMasterRegister(passport, [{ id: "x" }, { id: "y" }], [doc("x", "2026-10-10"), doc("y", "2026-09-01")], today);
    expect(rows.map((r) => r.subject.id)).toEqual(["y", "x"]);
  });

  it("prefers a dated document over an undated one for the same subject", () => {
    const rows = buildMasterRegister(passport, [{ id: "a" }], [doc("a", null), doc("a", "2026-11-01")], today);
    expect(rows[0]).toMatchObject({ state: "due", daysLeft: 18 });
  });

  it("ignores documents of subjects outside the master", () => {
    const rows = buildMasterRegister(passport, [{ id: "a" }], [doc("a", "2030-01-01"), doc("zz", "2026-01-01")], today);
    expect(rows.map((r) => r.subject.id)).toEqual(["a"]);
  });

  it("lists only the passes held when a master is not required of everyone", () => {
    const rows = buildMasterRegister(gatePass, subjects, [doc("b", "2027-06-01", { type: "sohar_gate_pass" })], today);
    expect(rows.map((r) => [r.subject.id, r.state])).toEqual([["b", "valid"]]);
  });

  it("treats the last day of validity as due, not expired", () => {
    expect(buildMasterRegister(passport, [{ id: "a" }], [doc("a", today)], today)[0]).toMatchObject({ state: "due", daysLeft: 0 });
  });
});

describe("summariseMaster", () => {
  it("counts every row once, by state, plus the documents not yet verified", () => {
    const master = masterByKey("company_registration")! as MasterDefinition;
    const rows = buildMasterRegister(
      master,
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
      [
        { subjectId: "a", type: "commercial_registration", expiryDate: "2030-01-01", verified: true },
        { subjectId: "b", type: "commercial_registration", expiryDate: "2026-11-01", verified: false },
        { subjectId: "c", type: "commercial_registration", expiryDate: "2026-01-01", verified: true },
        { subjectId: "d", type: "commercial_registration", expiryDate: null, verified: false },
      ],
      "2026-10-14",
    );
    const summary = summariseMaster(rows);
    expect(summary).toEqual({ total: 5, valid: 1, due: 1, expired: 1, noExpiry: 1, missing: 1, unverified: 2 });
    expect(summary.valid + summary.due + summary.expired + summary.noExpiry + summary.missing).toBe(summary.total);
  });

  it("is all zeros for an empty register", () => {
    expect(summariseMaster([])).toEqual({ total: 0, valid: 0, due: 0, expired: 0, noExpiry: 0, missing: 0, unverified: 0 });
  });
});
