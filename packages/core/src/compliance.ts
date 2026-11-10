import { addDays, daysBetween, isValidDate, rangesOverlap, type CalendarDate, type DateRange } from "./dates";

/**
 * The single answer to "may this worker work here on these dates?"
 * Roster, clock-in, payroll and matching all call this function (PRD 4.3, Spec 4.1).
 */

export const DOCUMENT_TYPES = [
  "passport",
  "residence_visa",
  "labour_card",
  "civil_id",
  "medical",
  "driving_licence",
  "trade_certificate",
  "insurance",
  "medical_insurance",
  "sohar_gate_pass",
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const WORKER_STATUSES = [
  "in_recruitment",
  "available",
  "deployed",
  "on_leave",
  "absconding_reported",
  "exited",
] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];

const ACTIVE_STATUSES: readonly WorkerStatus[] = ["available", "deployed", "on_leave"];

export interface WorkerDocument {
  type: DocumentType;
  expiryDate: CalendarDate | null;
  verified: boolean;
}

export type BlockerCode =
  | "MISSING_DOCUMENT"
  | "DOCUMENT_EXPIRED"
  | "DOCUMENT_EXPIRES_DURING_PERIOD"
  | "EXPIRY_DATE_MISSING"
  | "WORKER_NOT_ACTIVE"
  | "LEAVE_OVERLAP"
  | "NO_ENGAGEMENT"
  | "UNAUTHORISED_ENGAGEMENT";

/**
 * How a worker comes to work for the company (PRD 4.18): sponsored by it (own), used under a
 * Ministry authorisation from their sponsor (supplied), on a registered temporary transfer
 * (transferred, Ministerial Decision 730/2024), or with no authorisation at all (free_visa).
 */
export const ENGAGEMENTS = ["own", "supplied", "transferred", "free_visa"] as const;
export type Engagement = (typeof ENGAGEMENTS)[number];

/** One dated sponsorship record; `to: null` means open-ended. */
export interface EngagementPeriod {
  engagement: Engagement;
  from: CalendarDate;
  to: CalendarDate | null;
  /** A Ministry authorisation or registered transfer is on file (ignored for own and free_visa). */
  hasAuthorisation: boolean;
}

/**
 * The company setting `outsourcing.unauthorised` (A22). With "allow_with_owner_approval" an
 * unauthorised engagement can be lifted by an owner-approved override; with "block" nothing lifts it.
 */
export type UnauthorisedPolicy = "allow_with_owner_approval" | "block";

export type WarningCode = "DOCUMENT_EXPIRING_SOON" | "DOCUMENT_UNVERIFIED" | "OVERRIDDEN";

/** Blockers that no override may ever lift. */
const NON_OVERRIDABLE: readonly BlockerCode[] = ["WORKER_NOT_ACTIVE", "NO_ENGAGEMENT"];

export interface Issue<C extends string = string> {
  code: C;
  message: string;
  documentType?: DocumentType;
}

export interface OverriddenIssue extends Issue<"OVERRIDDEN"> {
  overriddenCode: BlockerCode;
  approvedBy: string;
  reason: string;
  validUntil: CalendarDate;
}

export interface Override {
  code: BlockerCode;
  documentType?: DocumentType;
  validUntil: CalendarDate;
  approvedBy: string;
  reason: string;
}

export interface ComplianceRules {
  /** Documents every deployed worker must hold, own or outsourced (PRD 4.1, A28). */
  mandatoryDocuments: readonly DocumentType[];
  /** Warn when a document expires within this many days after the period ends. */
  expiringSoonDays: number;
}

export const DEFAULT_COMPLIANCE_RULES: ComplianceRules = {
  mandatoryDocuments: ["passport", "residence_visa", "labour_card", "medical", "civil_id", "medical_insurance"],
  expiringSoonDays: 30,
};

export interface EligibilityInput {
  worker: { id: string; status: WorkerStatus };
  documents: readonly WorkerDocument[];
  period: DateRange;
  today: CalendarDate;
  site?: { id: string; requiredDocuments: readonly DocumentType[] };
  leave?: readonly DateRange[];
  overrides?: readonly Override[];
  rules?: ComplianceRules;
  /** The worker's sponsorship records. Omitted: no engagement check (callers that predate sponsors). */
  engagements?: readonly EngagementPeriod[];
  unauthorisedPolicy?: UnauthorisedPolicy;
}

export interface EligibilityResult {
  eligible: boolean;
  blockers: Issue<BlockerCode>[];
  warnings: (Issue<WarningCode> | OverriddenIssue)[];
}

const LABELS: Record<DocumentType, string> = {
  passport: "Passport",
  residence_visa: "Residence visa",
  labour_card: "Labour card",
  civil_id: "Oman ID card",
  medical: "Medical fitness",
  driving_licence: "Driving licence",
  trade_certificate: "Trade certificate",
  insurance: "Insurance",
  medical_insurance: "Medical insurance",
  sohar_gate_pass: "Sohar gate pass",
};

export function documentLabel(type: DocumentType): string {
  return LABELS[type];
}

/** For each type, the document with the latest expiry (a renewal supersedes the old one). */
export function latestByType(documents: readonly WorkerDocument[]): Map<DocumentType, WorkerDocument> {
  const latest = new Map<DocumentType, WorkerDocument>();
  for (const doc of documents) {
    const current = latest.get(doc.type);
    if (!current || (doc.expiryDate ?? "") > (current.expiryDate ?? "")) {
      latest.set(doc.type, doc);
    }
  }
  return latest;
}

function validateInput(input: EligibilityInput): void {
  const { from, to } = input.period;
  if (!isValidDate(from) || !isValidDate(to) || to < from) {
    throw new Error(`Invalid period ${from} → ${to}`);
  }
  for (const o of input.overrides ?? []) {
    if (!o.approvedBy.trim() || !o.reason.trim()) {
      throw new Error("Every override needs a named approver and a reason");
    }
  }
  for (const e of input.engagements ?? []) {
    if (!isValidDate(e.from) || (e.to !== null && (!isValidDate(e.to) || e.to < e.from))) {
      throw new Error(`Invalid engagement ${e.from} → ${e.to ?? "open"}`);
    }
  }
}

const ENGAGEMENT_LABELS: Record<Engagement, string> = {
  own: "Own worker",
  supplied: "Supplied worker",
  transferred: "Transferred worker",
  free_visa: "Free visa worker",
};

/** Every stretch of the period that no engagement covers, as [from, to] pairs. */
function uncoveredSpans(engagements: readonly EngagementPeriod[], period: DateRange): DateRange[] {
  const covering = engagements
    .filter((e) => rangesOverlap({ from: e.from, to: e.to ?? period.to }, period))
    .sort((a, b) => (a.from < b.from ? -1 : 1));
  const gaps: DateRange[] = [];
  let cursor = period.from;
  for (const e of covering) {
    if (e.from > cursor) gaps.push({ from: cursor, to: addDays(e.from, -1) });
    const end = e.to ?? period.to;
    if (end >= cursor) cursor = addDays(end, 1);
    if (cursor > period.to) return gaps;
  }
  if (cursor <= period.to) gaps.push({ from: cursor, to: period.to });
  return gaps;
}

function engagementBlockers(input: EligibilityInput): Issue<BlockerCode>[] {
  const engagements = input.engagements;
  if (!engagements) return [];
  const { period } = input;
  const blockers: Issue<BlockerCode>[] = uncoveredSpans(engagements, period).map((gap) => ({
    code: "NO_ENGAGEMENT",
    message: `No sponsor or engagement is recorded for ${gap.from} → ${gap.to}`,
  }));
  const unauthorised = engagements.find(
    (e) =>
      rangesOverlap({ from: e.from, to: e.to ?? period.to }, period) &&
      (e.engagement === "free_visa" || (e.engagement !== "own" && !e.hasAuthorisation)),
  );
  if (unauthorised) {
    const why = unauthorised.engagement === "free_visa" ? "works with no authorisation" : "has no Ministry authorisation or registered transfer on file";
    blockers.push({
      code: "UNAUTHORISED_ENGAGEMENT",
      message:
        input.unauthorisedPolicy === "block"
          ? `${ENGAGEMENT_LABELS[unauthorised.engagement]} ${why}; the company setting blocks this`
          : `${ENGAGEMENT_LABELS[unauthorised.engagement]} ${why}; needs the owner's approval`,
    });
  }
  return blockers;
}

export function checkEligibility(input: EligibilityInput): EligibilityResult {
  validateInput(input);
  const rules = input.rules ?? DEFAULT_COMPLIANCE_RULES;
  const { period } = input;
  const blockers: Issue<BlockerCode>[] = [];
  const warnings: EligibilityResult["warnings"] = [];

  if (!ACTIVE_STATUSES.includes(input.worker.status)) {
    blockers.push({
      code: "WORKER_NOT_ACTIVE",
      message: `Worker status is "${input.worker.status}"`,
    });
  }

  const required = new Set<DocumentType>([
    ...rules.mandatoryDocuments,
    ...(input.site?.requiredDocuments ?? []),
  ]);
  const latest = latestByType(input.documents);
  const soonLimit = addDays(period.to, rules.expiringSoonDays);

  for (const type of required) {
    const label = LABELS[type];
    const doc = latest.get(type);
    if (!doc) {
      blockers.push({ code: "MISSING_DOCUMENT", documentType: type, message: `${label} is missing` });
      continue;
    }
    if (doc.expiryDate === null) {
      blockers.push({ code: "EXPIRY_DATE_MISSING", documentType: type, message: `${label} has no expiry date recorded` });
      continue;
    }
    if (doc.expiryDate < period.from) {
      blockers.push({ code: "DOCUMENT_EXPIRED", documentType: type, message: `${label} expired on ${doc.expiryDate}` });
    } else if (doc.expiryDate < period.to) {
      blockers.push({
        code: "DOCUMENT_EXPIRES_DURING_PERIOD",
        documentType: type,
        message: `${label} expires on ${doc.expiryDate}, before the period ends`,
      });
    } else if (doc.expiryDate <= soonLimit) {
      warnings.push({
        code: "DOCUMENT_EXPIRING_SOON",
        documentType: type,
        message: `${label} expires on ${doc.expiryDate} (${daysBetween(period.to, doc.expiryDate)} days after the period)`,
      });
    }
    if (!doc.verified) {
      warnings.push({ code: "DOCUMENT_UNVERIFIED", documentType: type, message: `${label} not yet verified by HR` });
    }
  }

  const overlapping = (input.leave ?? []).find((l) => rangesOverlap(l, period));
  if (overlapping) {
    blockers.push({
      code: "LEAVE_OVERLAP",
      message: `Approved leave ${overlapping.from} → ${overlapping.to} overlaps the period`,
    });
  }

  blockers.push(...engagementBlockers(input));

  const locked = input.unauthorisedPolicy === "block" ? [...NON_OVERRIDABLE, "UNAUTHORISED_ENGAGEMENT" as const] : NON_OVERRIDABLE;
  const remaining = applyOverrides(blockers, input.overrides ?? [], period.to, warnings, locked);
  return { eligible: remaining.length === 0, blockers: remaining, warnings };
}

function applyOverrides(
  blockers: Issue<BlockerCode>[],
  overrides: readonly Override[],
  periodEnd: CalendarDate,
  warnings: EligibilityResult["warnings"],
  nonOverridable: readonly BlockerCode[],
): Issue<BlockerCode>[] {
  return blockers.filter((b) => {
    if (nonOverridable.includes(b.code)) return true;
    const match = overrides.find(
      (o) => o.code === b.code && o.documentType === b.documentType && o.validUntil >= periodEnd,
    );
    if (!match) return true;
    warnings.push({
      code: "OVERRIDDEN",
      overriddenCode: b.code,
      documentType: b.documentType,
      approvedBy: match.approvedBy,
      reason: match.reason,
      validUntil: match.validUntil,
      message: `${b.message} — overridden by ${match.approvedBy} until ${match.validUntil}: ${match.reason}`,
    });
    return false;
  });
}
