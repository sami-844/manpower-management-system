import { documentLabel, type DocumentType, type Engagement } from "./compliance";
import type { CalendarDate } from "./dates";
import { DEFAULT_RENEWAL_TIERS, renewalStatus } from "./renewals";

/**
 * The document masters (PRD 4.19, TR-ENG-15, DECISIONS A26-A30): eighteen registers in three groups,
 * each showing for every company or worker it covers the document with the latest expiry and its state.
 */

/** Documents a company holds: the company itself, a sub-contractor or a client. */
export const ORGANISATION_DOCUMENT_TYPES = [
  "commercial_registration",
  "chamber_certificate",
  "tax_card",
  "vat_certificate",
  "activity_licence",
  "tenancy_agreement",
  "municipality_licence",
  "labour_authorisation",
] as const;
export type OrganisationDocumentType = (typeof ORGANISATION_DOCUMENT_TYPES)[number];

const ORGANISATION_LABELS: Record<OrganisationDocumentType, string> = {
  commercial_registration: "Company registration certificate",
  chamber_certificate: "Chamber of Commerce & Industry certificate",
  tax_card: "Tax card",
  vat_certificate: "VAT certificate",
  activity_licence: "Activity licence",
  tenancy_agreement: "Tenancy agreement",
  municipality_licence: "Municipality licence",
  labour_authorisation: "Labour authorisation",
};

export function organisationDocumentLabel(type: OrganisationDocumentType): string {
  return ORGANISATION_LABELS[type];
}

export const MASTER_GROUPS = ["in_house", "purchase", "sales"] as const;
export type MasterGroup = (typeof MASTER_GROUPS)[number];
export const MASTER_GROUP_LABELS: Record<MasterGroup, string> = { in_house: "In House", purchase: "Purchase", sales: "Sales" };

/**
 * Whose documents a master holds. The company is its own sponsor record (PRD 4.18); sub-contractors
 * are the outside sponsors (A29); direct and indirect employees are workers by their engagement that day.
 */
export type MasterSubject = "company" | "subcontractor" | "client" | "direct_employee" | "indirect_employee";

interface MasterBase {
  no: number;
  key: string;
  group: MasterGroup;
  label: string;
  /** False when only some subjects need it (a Sohar gate pass, by site): no one counts as missing. */
  requiredOfAll: boolean;
}
export interface OrganisationMaster extends MasterBase {
  subject: "company" | "subcontractor" | "client";
  documentType: OrganisationDocumentType;
}
export interface WorkerMaster extends MasterBase {
  subject: "direct_employee" | "indirect_employee";
  documentType: DocumentType;
}
export type MasterDefinition = OrganisationMaster | WorkerMaster;

export function isWorkerMaster(master: MasterDefinition): master is WorkerMaster {
  return master.subject === "direct_employee" || master.subject === "indirect_employee";
}

const company = (no: number, key: string, documentType: OrganisationDocumentType): MasterDefinition => ({
  no,
  key,
  group: "in_house",
  label: ORGANISATION_LABELS[documentType],
  requiredOfAll: true,
  subject: "company",
  documentType,
});

const employees = (
  first: number,
  group: MasterGroup,
  subject: "direct_employee" | "indirect_employee",
): MasterDefinition[] => {
  const prefix = subject === "direct_employee" ? "direct" : "indirect";
  const who = subject === "direct_employee" ? "Direct employee" : "Indirect employee";
  const types: [string, DocumentType, string, boolean][] = [
    ["passport", "passport", "passport", true],
    ["oman_id", "civil_id", "Oman ID card", true],
    ["medical_insurance", "medical_insurance", "medical insurance", true],
    ["sohar_gate_pass", "sohar_gate_pass", "Sohar gate pass", false],
  ];
  return types.map(([suffix, documentType, what, requiredOfAll], i) => ({
    no: first + i,
    key: `${prefix}_${suffix}`,
    group,
    label: `${who} ${what}`,
    requiredOfAll,
    subject,
    documentType,
  }));
};

export const MASTERS: readonly MasterDefinition[] = [
  company(1, "company_registration", "commercial_registration"),
  company(2, "chamber_certificate", "chamber_certificate"),
  company(3, "tax_card", "tax_card"),
  company(4, "vat_certificate", "vat_certificate"),
  company(5, "activity_licence", "activity_licence"),
  company(6, "tenancy_agreement", "tenancy_agreement"),
  company(7, "municipality_licence", "municipality_licence"),
  company(8, "labour_authorisation", "labour_authorisation"),
  ...employees(9, "in_house", "direct_employee"),
  {
    no: 13,
    key: "subcontractor_registration",
    group: "purchase",
    label: "Sub-contractor company registration certificate",
    requiredOfAll: true,
    subject: "subcontractor",
    documentType: "commercial_registration",
  },
  ...employees(14, "purchase", "indirect_employee"),
  {
    no: 18,
    key: "client_registration",
    group: "sales",
    label: "Client company registration certificate",
    requiredOfAll: true,
    subject: "client",
    documentType: "commercial_registration",
  },
];

export function masterByKey(key: string): MasterDefinition | undefined {
  return MASTERS.find((m) => m.key === key);
}

/** The label of the document itself ("Oman ID card"), as opposed to the master's ("Direct employee Oman ID card"). */
export function masterDocumentLabel(master: MasterDefinition): string {
  return isWorkerMaster(master) ? documentLabel(master.documentType) : organisationDocumentLabel(master.documentType);
}

/** Own workers are direct employees; supplied, transferred and free-visa workers are indirect. */
export function engagementSubject(engagement: Engagement): "direct_employee" | "indirect_employee" {
  return engagement === "own" ? "direct_employee" : "indirect_employee";
}

export type MasterState = "expired" | "missing" | "no_expiry" | "due" | "valid";

export interface MasterDocumentRef {
  subjectId: string;
  type: string;
  expiryDate: CalendarDate | null;
  verified: boolean;
}

export interface MasterRow<S, D> {
  subject: S;
  /** The document with the latest expiry (a renewal supersedes the old one); null when there is none. */
  document: D | null;
  state: MasterState;
  daysLeft: number | null;
}

const URGENCY: Record<MasterState, number> = { expired: 0, missing: 1, no_expiry: 2, due: 3, valid: 4 };

/**
 * One row per subject the master covers. A subject with no document of the master's type is
 * "missing" when the master is required of everyone, and left out otherwise. Most urgent first.
 */
export function buildMasterRegister<S extends { id: string }, D extends MasterDocumentRef>(
  master: MasterDefinition,
  subjects: readonly S[],
  documents: readonly D[],
  today: CalendarDate,
  tiers: readonly number[] = DEFAULT_RENEWAL_TIERS,
): MasterRow<S, D>[] {
  const latest = new Map<string, D>();
  for (const d of documents) {
    if (d.type !== master.documentType) continue;
    const current = latest.get(d.subjectId);
    if (!current || (d.expiryDate ?? "") > (current.expiryDate ?? "")) latest.set(d.subjectId, d);
  }

  const rows: MasterRow<S, D>[] = [];
  for (const subject of subjects) {
    const document = latest.get(subject.id) ?? null;
    if (!document) {
      if (master.requiredOfAll) rows.push({ subject, document: null, state: "missing", daysLeft: null });
      continue;
    }
    if (document.expiryDate === null) {
      rows.push({ subject, document, state: "no_expiry", daysLeft: null });
      continue;
    }
    const status = renewalStatus(document.expiryDate, today, tiers);
    const state: MasterState = status.state === "ok" ? "valid" : status.state;
    rows.push({ subject, document, state, daysLeft: status.daysLeft });
  }
  return rows.sort(
    (a, b) => URGENCY[a.state] - URGENCY[b.state] || (a.daysLeft ?? 0) - (b.daysLeft ?? 0),
  );
}

export interface MasterSummary {
  total: number;
  valid: number;
  due: number;
  expired: number;
  noExpiry: number;
  missing: number;
  /** Rows whose document HR has not yet verified against the original. */
  unverified: number;
}

export function summariseMaster(rows: readonly MasterRow<unknown, { verified: boolean }>[]): MasterSummary {
  const summary: MasterSummary = { total: rows.length, valid: 0, due: 0, expired: 0, noExpiry: 0, missing: 0, unverified: 0 };
  for (const r of rows) {
    if (r.state === "no_expiry") summary.noExpiry += 1;
    else summary[r.state] += 1;
    if (r.document && !r.document.verified) summary.unverified += 1;
  }
  return summary;
}
