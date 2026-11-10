import { describe, expect, it } from "vitest";
import {
  checkEligibility,
  documentLabel,
  DOCUMENT_TYPES,
  DEFAULT_COMPLIANCE_RULES,
  type EligibilityInput,
  type WorkerDocument,
} from "./compliance";

// PRD 4.3 — "A worker with an expired mandatory document cannot be rostered,
// cannot clock in, and is flagged in payroll; overrides need a named approver
// and reason, and are logged."

const validDocs = (expiry = "2027-12-31"): WorkerDocument[] => [
  { type: "passport", expiryDate: expiry, verified: true },
  { type: "residence_visa", expiryDate: expiry, verified: true },
  { type: "labour_card", expiryDate: expiry, verified: true },
  { type: "medical", expiryDate: expiry, verified: true },
  { type: "civil_id", expiryDate: expiry, verified: true },
  { type: "medical_insurance", expiryDate: expiry, verified: true },
];

const base = (over: Partial<EligibilityInput> = {}): EligibilityInput => ({
  worker: { id: "W-000001", status: "available" },
  documents: validDocs(),
  period: { from: "2026-11-01", to: "2026-11-30" },
  today: "2026-10-14",
  ...over,
});

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("checkEligibility", () => {
  it("allows a worker with all mandatory documents valid for the whole period", () => {
    const result = checkEligibility(base());
    expect(result.eligible).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("blocks when a mandatory document is missing", () => {
    const docs = validDocs().filter((d) => d.type !== "labour_card");
    const result = checkEligibility(base({ documents: docs }));
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "MISSING_DOCUMENT", documentType: "labour_card" }),
    );
  });

  // A28 — every worker, own or outsourced, also needs an Oman ID card and medical insurance.
  it.each(["civil_id", "medical_insurance"] as const)("blocks when the %s is missing (A28)", (type) => {
    const result = checkEligibility(base({ documents: validDocs().filter((d) => d.type !== type) }));
    expect(result.eligible).toBe(false);
    expect(result.blockers).toEqual([expect.objectContaining({ code: "MISSING_DOCUMENT", documentType: type })]);
  });

  it("requires a Sohar gate pass only on a site that asks for one (A28)", () => {
    expect(checkEligibility(base()).eligible).toBe(true);
    const sohar = { id: "site-sohar", requiredDocuments: ["sohar_gate_pass"] as const };
    expect(codes(checkEligibility(base({ site: sohar })).blockers)).toEqual(["MISSING_DOCUMENT"]);
    const withPass = [...validDocs(), { type: "sohar_gate_pass" as const, expiryDate: "2027-12-31", verified: true }];
    expect(checkEligibility(base({ site: sohar, documents: withPass })).eligible).toBe(true);
  });

  it("blocks when a mandatory document has already expired before the period starts", () => {
    const docs = validDocs().map((d) =>
      d.type === "residence_visa" ? { ...d, expiryDate: "2026-10-31" } : d,
    );
    const result = checkEligibility(base({ documents: docs }));
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "DOCUMENT_EXPIRED", documentType: "residence_visa" }),
    );
  });

  it("blocks when a document expires part-way through the period", () => {
    const docs = validDocs().map((d) =>
      d.type === "medical" ? { ...d, expiryDate: "2026-11-15" } : d,
    );
    const result = checkEligibility(base({ documents: docs }));
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "DOCUMENT_EXPIRES_DURING_PERIOD", documentType: "medical" }),
    );
  });

  it("treats the expiry date itself as the last valid day", () => {
    const result = checkEligibility(base({ documents: validDocs("2026-11-30") }));
    expect(result.blockers).toEqual([]);
  });

  it("blocks when a document has no expiry date recorded", () => {
    const docs = validDocs().map((d) => (d.type === "passport" ? { ...d, expiryDate: null } : d));
    const result = checkEligibility(base({ documents: docs }));
    expect(codes(result.blockers)).toContain("EXPIRY_DATE_MISSING");
  });

  it("warns, but does not block, when a document expires within 30 days after the period", () => {
    const docs = validDocs().map((d) =>
      d.type === "passport" ? { ...d, expiryDate: "2026-12-20" } : d,
    );
    const result = checkEligibility(base({ documents: docs }));
    expect(result.eligible).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: "DOCUMENT_EXPIRING_SOON", documentType: "passport" }),
    );
  });

  it("does not warn when expiry is more than 30 days after the period", () => {
    const docs = validDocs().map((d) =>
      d.type === "passport" ? { ...d, expiryDate: "2026-12-31" } : d,
    );
    expect(checkEligibility(base({ documents: docs })).warnings).toEqual([]);
  });

  it("warns when a document is not yet verified by HR", () => {
    const docs = validDocs().map((d) => (d.type === "medical" ? { ...d, verified: false } : d));
    const result = checkEligibility(base({ documents: docs }));
    expect(result.eligible).toBe(true);
    expect(codes(result.warnings)).toContain("DOCUMENT_UNVERIFIED");
  });

  it("uses the latest document when a type has been renewed", () => {
    const docs = [
      ...validDocs(),
      { type: "residence_visa" as const, expiryDate: "2026-01-01", verified: true },
    ];
    expect(checkEligibility(base({ documents: docs })).eligible).toBe(true);
  });

  it("applies extra documents required by the site", () => {
    const result = checkEligibility(
      base({ site: { id: "S-1", requiredDocuments: ["driving_licence"] } }),
    );
    expect(result.blockers).toContainEqual(
      expect.objectContaining({ code: "MISSING_DOCUMENT", documentType: "driving_licence" }),
    );
  });

  it.each(["exited", "absconding_reported", "in_recruitment"] as const)(
    "blocks a worker whose status is %s",
    (status) => {
      const result = checkEligibility(base({ worker: { id: "W-1", status } }));
      expect(codes(result.blockers)).toContain("WORKER_NOT_ACTIVE");
    },
  );

  it("blocks when approved leave overlaps the period", () => {
    const result = checkEligibility(
      base({ leave: [{ from: "2026-11-20", to: "2026-12-05" }] }),
    );
    expect(codes(result.blockers)).toContain("LEAVE_OVERLAP");
  });

  it("ignores leave outside the period", () => {
    const result = checkEligibility(base({ leave: [{ from: "2026-12-01", to: "2026-12-05" }] }));
    expect(result.eligible).toBe(true);
  });

  it("rejects a period that ends before it starts", () => {
    expect(() =>
      checkEligibility(base({ period: { from: "2026-11-30", to: "2026-11-01" } })),
    ).toThrow(/period/i);
  });

  describe("overrides", () => {
    const expiredVisa = validDocs().map((d) =>
      d.type === "residence_visa" ? { ...d, expiryDate: "2026-10-31" } : d,
    );

    it("turns a matching blocker into a warning that names the approver", () => {
      const result = checkEligibility(
        base({
          documents: expiredVisa,
          overrides: [
            {
              code: "DOCUMENT_EXPIRED",
              documentType: "residence_visa",
              validUntil: "2026-11-30",
              approvedBy: "ops.manager",
              reason: "Renewal submitted, receipt on file",
            },
          ],
        }),
      );
      expect(result.eligible).toBe(true);
      expect(result.blockers).toEqual([]);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: "OVERRIDDEN", overriddenCode: "DOCUMENT_EXPIRED", approvedBy: "ops.manager" }),
      );
    });

    it("does not apply an override that ends before the period ends", () => {
      const result = checkEligibility(
        base({
          documents: expiredVisa,
          overrides: [
            {
              code: "DOCUMENT_EXPIRED",
              documentType: "residence_visa",
              validUntil: "2026-11-10",
              approvedBy: "ops.manager",
              reason: "Short extension",
            },
          ],
        }),
      );
      expect(result.eligible).toBe(false);
    });

    it("does not apply an override for a different document", () => {
      const result = checkEligibility(
        base({
          documents: expiredVisa,
          overrides: [
            {
              code: "DOCUMENT_EXPIRED",
              documentType: "passport",
              validUntil: "2026-12-31",
              approvedBy: "ops.manager",
              reason: "Wrong document",
            },
          ],
        }),
      );
      expect(result.eligible).toBe(false);
    });

    it("refuses an override without an approver or reason", () => {
      expect(() =>
        checkEligibility(
          base({
            documents: expiredVisa,
            overrides: [
              { code: "DOCUMENT_EXPIRED", documentType: "residence_visa", validUntil: "2026-12-31", approvedBy: "", reason: "" },
            ],
          }),
        ),
      ).toThrow(/approver/i);
    });

    it("never overrides an inactive worker status", () => {
      const result = checkEligibility(
        base({
          worker: { id: "W-1", status: "exited" },
          overrides: [
            { code: "WORKER_NOT_ACTIVE", validUntil: "2027-01-01", approvedBy: "gm", reason: "test" },
          ],
        }),
      );
      expect(result.eligible).toBe(false);
    });
  });

  it("uses configurable mandatory documents and warning window", () => {
    const result = checkEligibility({
      ...base({ documents: validDocs().filter((d) => d.type !== "medical") }),
      rules: { ...DEFAULT_COMPLIANCE_RULES, mandatoryDocuments: ["passport"], expiringSoonDays: 60 },
    });
    expect(result.blockers).toEqual([]);
  });
});

describe("checkEligibility — edge cases found by mutation testing", () => {
  it("uses the renewed document even when it is entered after the old one", () => {
    const docs = [
      ...validDocs().filter((d) => d.type !== "residence_visa"),
      { type: "residence_visa" as const, expiryDate: "2026-10-20", verified: true },
      { type: "residence_visa" as const, expiryDate: "2028-10-20", verified: true },
    ];
    expect(checkEligibility(base({ documents: docs })).eligible).toBe(true);
  });

  it("prefers a dated document over an undated duplicate in either order", () => {
    const dated = { type: "medical" as const, expiryDate: "2027-12-31", verified: true };
    const undated = { type: "medical" as const, expiryDate: null, verified: true };
    const others = validDocs().filter((d) => d.type !== "medical");
    expect(checkEligibility(base({ documents: [...others, undated, dated] })).eligible).toBe(true);
    expect(checkEligibility(base({ documents: [...others, dated, undated] })).eligible).toBe(true);
  });

  it("treats a document expiring on the first day of the period as expiring during it", () => {
    const docs = validDocs().map((d) => (d.type === "passport" ? { ...d, expiryDate: "2026-11-01" } : d));
    expect(codes(checkEligibility(base({ documents: docs })).blockers)).toEqual(["DOCUMENT_EXPIRES_DURING_PERIOD"]);
  });

  it("warns when expiry falls exactly on the last day of the warning window", () => {
    const docs = validDocs().map((d) => (d.type === "passport" ? { ...d, expiryDate: "2026-12-30" } : d));
    expect(codes(checkEligibility(base({ documents: docs })).warnings)).toEqual(["DOCUMENT_EXPIRING_SOON"]);
  });

  it("accepts a single-day period", () => {
    expect(checkEligibility(base({ period: { from: "2026-11-05", to: "2026-11-05" } })).eligible).toBe(true);
  });

  it.each([
    [{ from: "2026-11-31", to: "2026-12-05" }],
    [{ from: "2026-11-01", to: "2026-13-01" }],
  ])("rejects an invalid calendar date in the period %o", (period) => {
    expect(() => checkEligibility(base({ period }))).toThrow(/period/i);
  });

  it.each([
    ["", "Renewal submitted"],
    ["ops.manager", "   "],
    ["   ", "Renewal submitted"],
  ])("refuses an override with approver %j and reason %j", (approvedBy, reason) => {
    expect(() =>
      checkEligibility(
        base({ overrides: [{ code: "DOCUMENT_EXPIRED", validUntil: "2026-12-31", approvedBy, reason }] }),
      ),
    ).toThrow(/approver/i);
  });

  it("does not apply an override for a different blocker on the same document", () => {
    const docs = validDocs().map((d) => (d.type === "medical" ? { ...d, expiryDate: "2026-11-15" } : d));
    const result = checkEligibility(
      base({
        documents: docs,
        overrides: [
          { code: "DOCUMENT_EXPIRED", documentType: "medical", validUntil: "2026-12-31", approvedBy: "hr", reason: "x" },
        ],
      }),
    );
    expect(result.eligible).toBe(false);
  });

  it.each(["available", "deployed", "on_leave"] as const)("treats status %s as active", (status) => {
    expect(checkEligibility(base({ worker: { id: "W-1", status } })).eligible).toBe(true);
  });

  it("explains each issue in words HR can act on", () => {
    const docs = [
      { type: "passport" as const, expiryDate: "2026-10-31", verified: true },
      { type: "residence_visa" as const, expiryDate: "2026-11-15", verified: true },
      { type: "medical" as const, expiryDate: null, verified: true },
      { type: "labour_card" as const, expiryDate: "2026-12-20", verified: false },
    ];
    const r = checkEligibility(
      base({
        worker: { id: "W-1", status: "exited" },
        documents: docs,
        site: { id: "S-1", requiredDocuments: ["driving_licence"] },
        leave: [{ from: "2026-11-10", to: "2026-11-12" }],
      }),
    );
    const text = [...r.blockers, ...r.warnings].map((i) => i.message);
    expect(text).toEqual(
      expect.arrayContaining([
        'Worker status is "exited"',
        "Passport expired on 2026-10-31",
        "Residence visa expires on 2026-11-15, before the period ends",
        "Medical fitness has no expiry date recorded",
        "Driving licence is missing",
        "Labour card expires on 2026-12-20 (20 days after the period)",
        "Labour card not yet verified by HR",
        "Approved leave 2026-11-10 → 2026-11-12 overlaps the period",
      ]),
    );
  });

  it("records the override in the warning message", () => {
    const docs = validDocs().map((d) => (d.type === "passport" ? { ...d, expiryDate: "2026-10-31" } : d));
    const r = checkEligibility(
      base({
        documents: docs,
        overrides: [
          { code: "DOCUMENT_EXPIRED", documentType: "passport", validUntil: "2026-11-30", approvedBy: "gm", reason: "Renewal at embassy" },
        ],
      }),
    );
    expect(r.warnings[0]?.message).toBe(
      "Passport expired on 2026-10-31 — overridden by gm until 2026-11-30: Renewal at embassy",
    );
  });
});

describe("documentLabel", () => {
  it("names every document type for display", () => {
    expect(DOCUMENT_TYPES.map(documentLabel)).toEqual([
      "Passport",
      "Residence visa",
      "Labour card",
      "Oman ID card",
      "Medical fitness",
      "Driving licence",
      "Trade certificate",
      "Insurance",
      "Medical insurance",
      "Sohar gate pass",
    ]);
  });

  it("makes the A28 set mandatory by default", () => {
    expect(DEFAULT_COMPLIANCE_RULES.mandatoryDocuments).toEqual([
      "passport",
      "residence_visa",
      "labour_card",
      "medical",
      "civil_id",
      "medical_insurance",
    ]);
  });
});

// PRD 4.18, A22 — a worker the company does not sponsor needs a recorded basis for every day:
// own, an authorised supply or registered transfer, or the owner's approval of an unauthorised one.
describe("checkEligibility — engagements (sponsors and outsourced workers)", () => {
  const own = { engagement: "own" as const, from: "2026-01-01", to: null, hasAuthorisation: false };

  it("does not check engagements when none are given (callers that predate sponsors)", () => {
    expect(checkEligibility(base()).eligible).toBe(true);
  });

  it("allows an own worker and an authorised supplied or transferred worker", () => {
    expect(checkEligibility(base({ engagements: [own] })).eligible).toBe(true);
    for (const engagement of ["supplied", "transferred"] as const) {
      const r = checkEligibility(base({ engagements: [{ engagement, from: "2026-10-01", to: "2026-12-31", hasAuthorisation: true }] }));
      expect(r.blockers).toEqual([]);
    }
  });

  it("blocks days with no engagement recorded, and no override lifts it", () => {
    const partial = [{ ...own, from: "2026-11-10" }];
    const r = checkEligibility(
      base({
        engagements: partial,
        overrides: [{ code: "NO_ENGAGEMENT", validUntil: "2026-12-31", approvedBy: "owner", reason: "try" }],
      }),
    );
    expect(codes(r.blockers)).toEqual(["NO_ENGAGEMENT"]);
    expect(r.blockers[0]!.message).toContain("2026-11-01");
    expect(r.blockers[0]!.message).toContain("2026-11-09");
  });

  it("finds a gap between two engagements and after one that ends", () => {
    const r = checkEligibility(
      base({
        engagements: [
          { ...own, to: "2026-11-05" },
          { engagement: "supplied", from: "2026-11-08", to: "2026-11-25", hasAuthorisation: true },
        ],
      }),
    );
    expect(r.blockers.filter((b) => b.code === "NO_ENGAGEMENT")).toHaveLength(2);
  });

  it.each([
    ["free_visa", true],
    ["free_visa", false],
    ["supplied", false],
    ["transferred", false],
  ] as const)("blocks %s (authorisation on file: %s) as unauthorised", (engagement, hasAuthorisation) => {
    const r = checkEligibility(base({ engagements: [{ engagement, from: "2026-10-01", to: null, hasAuthorisation }] }));
    expect(codes(r.blockers)).toEqual(["UNAUTHORISED_ENGAGEMENT"]);
  });

  it("lets an owner-approved override lift an unauthorised engagement while the policy allows it", () => {
    const override = { code: "UNAUTHORISED_ENGAGEMENT" as const, validUntil: "2026-11-30", approvedBy: "owner", reason: "Client deadline" };
    const engagements = [{ engagement: "free_visa" as const, from: "2026-10-01", to: null, hasAuthorisation: false }];
    const allowed = checkEligibility(base({ engagements, overrides: [override], unauthorisedPolicy: "allow_with_owner_approval" }));
    expect(allowed.eligible).toBe(true);
    expect(allowed.warnings).toContainEqual(expect.objectContaining({ code: "OVERRIDDEN", overriddenCode: "UNAUTHORISED_ENGAGEMENT" }));
    const defaulted = checkEligibility(base({ engagements, overrides: [override] }));
    expect(defaulted.eligible).toBe(true);
  });

  it("refuses every override for an unauthorised engagement when the policy is block", () => {
    const r = checkEligibility(
      base({
        engagements: [{ engagement: "supplied", from: "2026-10-01", to: null, hasAuthorisation: false }],
        overrides: [{ code: "UNAUTHORISED_ENGAGEMENT", validUntil: "2026-12-31", approvedBy: "owner", reason: "Client deadline" }],
        unauthorisedPolicy: "block",
      }),
    );
    expect(codes(r.blockers)).toEqual(["UNAUTHORISED_ENGAGEMENT"]);
  });

  it("names the engagement and the dates in words HR can act on", () => {
    const r = checkEligibility(base({ engagements: [{ engagement: "free_visa", from: "2026-10-01", to: null, hasAuthorisation: false }] }));
    expect(r.blockers[0]!.message).toMatch(/free visa/i);
    expect(r.blockers[0]!.message).toMatch(/owner/i);
  });

  it("ignores engagements outside the period", () => {
    const r = checkEligibility(
      base({
        engagements: [
          { engagement: "free_visa", from: "2026-01-01", to: "2026-10-31", hasAuthorisation: false },
          { ...own, from: "2026-11-01" },
        ],
      }),
    );
    expect(r.eligible).toBe(true);
  });

  it("rejects an engagement that ends before it starts", () => {
    expect(() => checkEligibility(base({ engagements: [{ ...own, from: "2026-11-10", to: "2026-11-01" }] }))).toThrow(/engagement/i);
  });
});
