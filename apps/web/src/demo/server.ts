/**
 * HOSTED DEMO API — a browser stand-in for `apps/api`, used ONLY by the Cloudflare demo build
 * (`vite build --mode demo`, see `lib/api.ts`). The hosted demo has no PostgreSQL, so the
 * endpoints the web app calls are answered here, in memory, per visitor (uploaded scans too).
 * A reload starts a fresh demo; nothing leaves the browser.
 *
 * It is not a second backend: every rule comes from `@mms/core` (the same engines the API
 * calls), the validation mirrors the API's zod schemas (`apps/api/src/workers/workers.service.ts`,
 * `compliance/compliance.service.ts`), and the people come from the same fictional recipe as
 * `apps/api/src/db/seed.ts` (CLAUDE.md rule 10: no real personal data). If an API endpoint
 * changes, change it here too; `server.test.ts` pins the shared behaviour.
 */
import {
  addDays,
  buildMasterRegister,
  buildRenewalQueue,
  checkEligibility,
  daysBetween,
  DOCUMENT_TYPES,
  engagementSubject,
  isValidDate,
  isWorkerMaster,
  MASTER_GROUP_LABELS,
  MASTER_GROUPS,
  masterByKey,
  masterDocumentLabel,
  MASTERS,
  ORGANISATION_DOCUMENT_TYPES,
  renewalStatus,
  summariseMaster,
  summariseWorkerCompliance,
  WORKER_STATUSES,
  type BlockerCode,
  type DocumentType,
  type Engagement,
  type MasterDefinition,
  type MasterSubject,
  type OrganisationDocumentType,
  type WorkerStatus,
} from "@mms/core";
import { z } from "zod";
import { ApiError } from "@/lib/api";
import { DEMO_ACCOUNTS, DEMO_ROLE_PERMISSIONS } from "@/lib/roles";
import { todayOman } from "./core";

// ---- Validation (mirrors apps/api) -------------------------------------------------------

const calendarDate = z.string().refine(isValidDate, { message: "Must be a real date in YYYY-MM-DD format" });
const uuid = z.string().uuid();

const createWorkerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  fullNameAr: z.string().trim().max(120).optional(),
  nationality: z.string().trim().min(2).max(60),
  trade: z.string().trim().min(2).max(60),
  status: z.enum(WORKER_STATUSES).default("available"),
  phone: z.string().trim().max(30).optional(),
  dateOfBirth: calendarDate.optional(),
  joinedOn: calendarDate.optional(),
});
const addDocumentSchema = z
  .object({
    type: z.enum(DOCUMENT_TYPES),
    number: z.string().trim().max(60).optional(),
    issueDate: calendarDate.optional(),
    expiryDate: calendarDate.nullable().optional(),
    verified: z.boolean().default(false),
  })
  .refine((d) => !d.issueDate || !d.expiryDate || d.issueDate <= d.expiryDate, {
    message: "Expiry date must be on or after the issue date",
    path: ["expiryDate"],
  });
const listWorkersSchema = z.object({
  search: z.string().trim().max(60).optional(),
  status: z.enum(WORKER_STATUSES).optional(),
  compliance: z.enum(["ok", "due", "incomplete", "expired"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const addLeaveSchema = z
  .object({ fromDate: calendarDate, toDate: calendarDate })
  .refine((l) => l.fromDate <= l.toDate, { message: "Leave must end on or after it starts", path: ["toDate"] });
const BLOCKER_CODES = [
  "MISSING_DOCUMENT",
  "DOCUMENT_EXPIRED",
  "DOCUMENT_EXPIRES_DURING_PERIOD",
  "EXPIRY_DATE_MISSING",
  "LEAVE_OVERLAP",
] as const satisfies readonly BlockerCode[];
const checkSchema = z
  .object({ workerId: uuid, siteId: uuid.optional(), from: calendarDate, to: calendarDate })
  .refine((p) => p.from <= p.to, { message: "Period must end on or after it starts", path: ["to"] });
const overrideSchema = z.object({
  code: z.enum(BLOCKER_CODES),
  documentType: z.string().optional(),
  validUntil: calendarDate,
  reason: z.string().trim().min(5, "Give a reason of at least 5 characters").max(500),
});

// Masters (apps/api/src/masters/masters.ts, sponsors/sponsors.ts)
const decimal = z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, "Must be an amount in OMR with at most 3 decimals");
const createClientSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  crNumber: z.string().trim().min(3).max(30).optional(),
  vatNumber: z.string().trim().min(3).max(30).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  creditLimit: decimal.optional(),
  status: z.enum(["prospect", "active", "on_hold"]).default("active"),
});
const optionalText = (max: number) => z.string().trim().max(max).optional().transform((v) => v || undefined);
const createSponsorSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  crNumber: optionalText(40),
  molEstablishmentNo: optionalText(40),
});
const addOrganisationDocumentSchema = z
  .object({
    subject: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("company") }),
      z.object({ kind: z.literal("subcontractor"), sponsorId: uuid }),
      z.object({ kind: z.literal("client"), clientId: uuid }),
    ]),
    type: z.enum(ORGANISATION_DOCUMENT_TYPES),
    number: z.string().trim().min(1).max(60).optional(),
    issueDate: calendarDate.optional(),
    expiryDate: calendarDate.nullable().optional(),
    verified: z.boolean().default(false),
  })
  .refine((d) => !d.issueDate || !d.expiryDate || d.issueDate <= d.expiryDate, {
    message: "Expiry date must be on or after the issue date",
    path: ["expiryDate"],
  });

/** Scans (apps/api/src/files/files.ts): the type from the first bytes, at most 15 MB. */
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
function detectMime(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 5 && ascii(0, 5) === "%PDF-") return "application/pdf";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return "image/png";
  if (b.length >= 12 && ascii(4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(8, 12))) return "image/heic";
  return null;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(
      400,
      "Validation failed",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

const notFound = (what: string) => new ApiError(404, `${what} not found`);
const problem = (status: number, code: string, message: string) => new ApiError(status, message, [], code);

/** Last 4 characters only (apps/api/src/common/mask.ts, CLAUDE.md rule 10). */
const mask = (v: string | null): string | null => (!v ? v : v.length <= 4 ? "••••" : `••••${v.slice(-4)}`);

// ---- Records (shapes of apps/api/src/db/schema.ts rows) --------------------------------

interface Worker {
  id: string; entityId: string; code: string; fullName: string; fullNameAr: string | null;
  nationality: string; trade: string; status: WorkerStatus; phone: string | null;
  dateOfBirth: string | null; joinedOn: string | null; createdAt: string; updatedAt: string;
}
interface Doc {
  id: string; entityId: string; workerId: string; type: DocumentType; number: string | null;
  issueDate: string | null; expiryDate: string | null; verified: boolean; verifiedBy: string | null;
  verifiedAt: string | null; fileId: string | null; createdAt: string; updatedAt: string;
}
interface Sponsor { id: string; kind: "own" | "external"; legalName: string; crNumber: string | null; molEstablishmentNo: string | null; status: string }
interface Client {
  id: string; code: string; legalName: string; crNumber: string | null; vatNumber: string | null;
  paymentTermsDays: number; creditLimit: string | null; status: string;
}
interface OrgDoc {
  id: string; sponsorId: string | null; clientId: string | null; type: OrganisationDocumentType; number: string | null;
  issueDate: string | null; expiryDate: string | null; verified: boolean; verifiedBy: string | null; verifiedAt: string | null;
  fileId: string | null; createdBy: string; createdAt: string;
}
interface Engaged { workerId: string; engagement: Engagement; sponsorId: string }
interface StoredFile { id: string; bytes: Uint8Array; mime: string; name: string }
interface Leave { id: string; entityId: string; workerId: string; fromDate: string; toDate: string; status: string; createdAt: string }
interface Override {
  id: string; entityId: string; workerId: string; code: BlockerCode; documentType: string | null;
  validUntil: string; approvedBy: string; reason: string; createdAt: string;
}
interface Site { id: string; entityId: string; code: string; name: string; clientName: string; requiredDocuments: DocumentType[]; createdAt: string; updatedAt: string }
interface AuditEvent {
  id: number; actor: string; action: string; subjectType: string; subjectId: string;
  before: unknown; after: unknown; at: string; prevHash: string; hash: string;
}

const ENTITY = "OM-01";
/** Stable UUID-shaped ids, so a shared link to `#/workers/<id>` opens the same person after a reload. */
const idOf = (kind: number, n: number) => `00000000-0000-4000-8${kind.toString(16).padStart(3, "0")}-${n.toString(16).padStart(12, "0")}`;

// ---- Fictional people (same recipe as apps/api/src/db/seed.ts) --------------------------

const FIRST = ["Rahim", "Karim", "Suresh", "Anil", "Bikash", "Imran", "Ravi", "Hasan", "Joseph", "Manoj", "Sabbir", "Arjun", "Faisal", "Ramesh", "Dipak", "Nasir", "Vinod", "Shakil", "Pradeep", "Asif"];
const LAST = ["Uddin", "Hossain", "Kumar", "Thapa", "Khan", "Rana", "Pillai", "Mia", "Nair", "Gurung", "Ahmed", "Islam", "Singh", "Shrestha", "Rahman", "Menon", "Ali", "Das", "Tamang", "Iqbal"];
const COUNTRIES = ["Bangladesh", "India", "Nepal", "Pakistan"];
const TRADES = ["General labourer", "Mason", "Carpenter", "Steel fixer", "Electrician", "Plumber", "Scaffolder", "Welder", "Equipment operator", "Driver"];
const DEMO_WORKERS = 680;

function seed(today: string, stamp: string) {
  let state = 20261014;
  const rand = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

  const site = (n: number, code: string, name: string, clientName: string, requiredDocuments: DocumentType[]): Site =>
    ({ id: idOf(3, n), entityId: ENTITY, code, name, clientName, requiredDocuments, createdAt: stamp, updatedAt: stamp });
  const sites = [
    site(1, "SOH-PORT", "Sohar Port Phase 3", "Gulf Build LLC", []),
    site(2, "MCT-TWR", "Muscat Tower Block B", "Al Noor Contracting", ["trade_certificate"]),
    site(3, "SOH-IND", "Sohar Industrial Yard", "Batinah Steel", ["driving_licence"]),
  ];

  const workers: Worker[] = [];
  const docs: Doc[] = [];
  for (let i = 1; i <= DEMO_WORKERS; i++) {
    const id = idOf(1, i);
    workers.push({
      id, entityId: ENTITY, code: `W-${String(i).padStart(6, "0")}`,
      fullName: `${pick(FIRST)} ${pick(LAST)}`, fullNameAr: null,
      nationality: pick(COUNTRIES), trade: pick(TRADES),
      status: rand() < 0.86 ? "deployed" : rand() < 0.6 ? "available" : "on_leave",
      phone: `+968 9${int(1000000, 9999999)}`, dateOfBirth: null, joinedOn: addDays(today, -int(30, 2000)),
      createdAt: stamp, updatedAt: stamp,
    });
    const roll = rand();
    const baseExpiry = (offset: number) => addDays(today, offset + int(0, 400));
    const doc = (type: DocumentType, number: string | null, expiryDate: string, verified: boolean): Doc => ({
      id: idOf(2, docs.length + 1), entityId: ENTITY, workerId: id, type, number, issueDate: null, expiryDate,
      verified, verifiedBy: verified ? "hr.officer" : null, verifiedAt: verified ? stamp : null, fileId: null, createdAt: stamp, updatedAt: stamp,
    });
    docs.push(doc("passport", `P${int(1000000, 9999999)}`, baseExpiry(500), true));
    docs.push(doc("residence_visa", `RV${int(100000, 999999)}`, roll < 0.12 ? addDays(today, int(1, 85)) : roll < 0.17 ? addDays(today, -int(1, 40)) : baseExpiry(120), true));
    docs.push(doc("labour_card", `LC${int(100000, 999999)}`, roll > 0.9 ? addDays(today, int(1, 60)) : baseExpiry(150), rand() > 0.05));
    if (roll > 0.04) docs.push(doc("medical", null, baseExpiry(60), true));
  }
  return { sites, workers, docs, ...seedMasters(today, stamp, workers, docs) };
}

// ---- Document masters (apps/api/src/db/seed.ts `seedMasters`) -----------------------------

/** Days from today to each company paper's expiry: a mix of valid, due and one expired. */
const COMPANY_PAPERS: Record<OrganisationDocumentType, number> = {
  commercial_registration: 210,
  chamber_certificate: 40,
  tax_card: 300,
  vat_certificate: 520,
  activity_licence: -5,
  tenancy_agreement: 130,
  municipality_licence: 75,
  labour_authorisation: 260,
};
const SUBCONTRACTORS = [
  { legalName: "Batinah Workforce Supply LLC", cr: "2000101", crExpiry: 180 },
  { legalName: "Dhofar Labour Contracting LLC", cr: "2000102", crExpiry: 25 },
];
const CLIENTS = [
  { legalName: "Gulf Build LLC", cr: "3000201", crExpiry: 400 },
  { legalName: "Al Noor Contracting", cr: "3000202", crExpiry: 12 },
  { legalName: "Batinah Steel", cr: "3000203", crExpiry: null }, // CR not recorded yet: shows as missing
];

function seedMasters(today: string, stamp: string, workers: Worker[], docs: Doc[]) {
  // Its own random sequence, so the workers above stay the same people.
  let state = 4_192_026;
  const rand = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

  const sponsors: Sponsor[] = [
    { id: idOf(6, 1), kind: "own", legalName: "Demo Manpower Services LLC", crNumber: "1000001", molEstablishmentNo: "EST-1000001", status: "active" },
    ...SUBCONTRACTORS.map((s, i): Sponsor => ({ id: idOf(6, i + 2), kind: "external", legalName: s.legalName, crNumber: s.cr, molEstablishmentNo: `EST-${s.cr}`, status: "active" })),
  ];
  const clients = CLIENTS.map((c, i): Client => ({
    id: idOf(7, i + 1), code: `C-${String(i + 1).padStart(5, "0")}`, legalName: c.legalName, crNumber: c.cr, vatNumber: `OM11${c.cr}`,
    paymentTermsDays: 30, creditLimit: null, status: "active",
  }));
  const orgDocs: OrgDoc[] = [];
  const paper = (owner: { sponsorId?: string; clientId?: string }, type: OrganisationDocumentType, number: string, days: number) =>
    orgDocs.push({
      id: idOf(8, orgDocs.length + 1), sponsorId: owner.sponsorId ?? null, clientId: owner.clientId ?? null, type, number,
      issueDate: addDays(today, days - 365), expiryDate: addDays(today, days), verified: true, verifiedBy: "hr.officer", verifiedAt: stamp,
      fileId: null, createdBy: "hr.officer", createdAt: stamp,
    });
  for (const type of ORGANISATION_DOCUMENT_TYPES) paper({ sponsorId: sponsors[0]!.id }, type, `${type.slice(0, 3).toUpperCase()}-${int(100000, 999999)}`, COMPANY_PAPERS[type]);
  SUBCONTRACTORS.forEach((s, i) => paper({ sponsorId: sponsors[i + 1]!.id }, "commercial_registration", s.cr, s.crExpiry));
  CLIENTS.forEach((c, i) => {
    if (c.crExpiry !== null) paper({ clientId: clients[i]!.id }, "commercial_registration", c.cr, c.crExpiry);
  });

  // Every sixteenth worker (by code) is supplied by a sub-contractor; the rest are the company's own.
  const engagements: Engaged[] = workers.map((w, i): Engaged =>
    i % 16 === 0 ? { workerId: w.id, engagement: "supplied", sponsorId: sponsors[1 + ((i / 16) % 2)]!.id } : { workerId: w.id, engagement: "own", sponsorId: sponsors[0]!.id },
  );

  // Oman ID cards and medical insurance for everyone (A28; every 33rd worker lacks insurance so
  // "missing" shows), Sohar gate passes for about a quarter.
  const add = (workerId: string, type: DocumentType, number: string, expiryDate: string, verified: boolean) =>
    docs.push({
      id: idOf(2, docs.length + 1), entityId: ENTITY, workerId, type, number, issueDate: null, expiryDate, verified,
      verifiedBy: verified ? "hr.officer" : null, verifiedAt: verified ? stamp : null, fileId: null, createdAt: stamp, updatedAt: stamp,
    });
  workers.forEach((w, i) => {
    add(w.id, "civil_id", `1${int(1000000, 9999999)}`, addDays(today, int(-10, 730)), true);
    if ((i + 1) % 33 !== 0) add(w.id, "medical_insurance", `MI-${int(100000, 999999)}`, addDays(today, int(-30, 330)), rand() > 0.05);
    if (rand() <= 0.25) add(w.id, "sohar_gate_pass", `SGP-${int(10000, 99999)}`, addDays(today, int(-15, 300)), true);
  });
  return { sponsors, clients, orgDocs, engagements };
}

/** The demo accounts' permissions (lib/roles.ts), for the rules finer than one route's permission. */
const grantsOf = (actor: string): readonly string[] => {
  const account = DEMO_ACCOUNTS.find((a) => a.username === actor);
  return account ? DEMO_ROLE_PERMISSIONS[account.role] : [];
};
/** apps/api/src/common/actor.ts `assertMayVerify`: recording a document as verified is a verification. */
function assertMayVerify(verified: boolean, actor: string) {
  if (verified && !grantsOf(actor).includes("documents.verify")) {
    throw problem(403, "VERIFY_NOT_ALLOWED", "Only someone who may verify documents can record one as verified.");
  }
}
/** The company's own papers (masters 1-8) are HR's alone (A30); operations keep clients' and sub-contractors'. */
function assertMayManageCompany(actor: string) {
  if (!grantsOf(actor).includes("company_documents.manage")) {
    throw problem(403, "COMPANY_DOCUMENTS_HR_ONLY", "Only HR/PRO record the company's own papers.");
  }
}

// ---- Audit hash chain (apps/api/src/audit/audit.service.ts) ------------------------------

const GENESIS = "0".repeat(64);
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const hashOf = (prev: string, e: Pick<AuditEvent, "actor" | "action" | "subjectType" | "subjectId" | "before" | "after">) =>
  sha256([prev, e.actor, e.action, e.subjectType, e.subjectId, canonical(e.before), canonical(e.after)].join("|"));

// ---- The server ---------------------------------------------------------------------------

export function createDemoServer(today: string = todayOman()) {
  const now = () => new Date().toISOString();
  const db = { ...seed(today, `${today}T05:00:00.000Z`), leave: [] as Leave[], overrides: [] as Override[], audit: [] as AuditEvent[], files: new Map<string, StoredFile>() };
  let nextWorker = db.workers.length + 1;
  let nextId = 1;
  const newId = (kind: number) => idOf(kind, 0x100000 + nextId++);

  async function record(actor: string, action: string, subjectType: string, subjectId: string, before: unknown, after: unknown) {
    const e = { actor, action, subjectType, subjectId, before: JSON.parse(JSON.stringify(before ?? null)), after: JSON.parse(JSON.stringify(after ?? null)) };
    const prevHash = db.audit.at(-1)?.hash ?? GENESIS;
    db.audit.push({ ...e, id: db.audit.length + 1, at: now(), prevHash, hash: await hashOf(prevHash, e) });
  }

  const docsByWorker = new Map<string, Doc[]>();
  const indexDoc = (d: Doc) => docsByWorker.set(d.workerId, [...(docsByWorker.get(d.workerId) ?? []), d]);
  db.docs.forEach(indexDoc);
  const docsOf = (workerId: string) => [...(docsByWorker.get(workerId) ?? [])];
  const coreDocs = (ds: Doc[]) => ds.map((d) => ({ type: d.type, expiryDate: d.expiryDate, verified: d.verified }));
  const findWorker = (id: string) => {
    const w = db.workers.find((x) => x.id === parse(uuid, id));
    if (!w) throw notFound("Worker");
    return w;
  };
  const withCompliance = (w: Worker) => ({
    id: w.id, code: w.code, fullName: w.fullName, nationality: w.nationality, trade: w.trade, status: w.status,
    compliance: summariseWorkerCompliance(coreDocs(docsOf(w.id)), today),
  });
  const allWithCompliance = (q: { search?: string; status?: string } = {}) => {
    const term = q.search?.toLowerCase();
    return db.workers
      .filter((w) => (!q.status || w.status === q.status) && (!term || w.fullName.toLowerCase().includes(term) || w.code.toLowerCase().includes(term)))
      .sort((a, b) => a.fullName.localeCompare(b.fullName))
      .map(withCompliance);
  };
  const shownDoc = (d: Doc) => ({ ...d, number: mask(d.number) });

  // ---- Masters (apps/api/src/masters/masters.ts) ----
  const ACTIVE = new Set<string>(["available", "deployed", "on_leave"]);
  interface Subject { id: string; kind: MasterSubject; name: string; code: string | null; status: string | null; engagement: string | null; sponsorName: string | null }
  type DocLike = Pick<Doc, "id" | "number" | "issueDate" | "expiryDate" | "verified" | "verifiedBy" | "verifiedAt" | "fileId"> & { type: string };
  const registerDoc = (subjectId: string, d: DocLike) => ({
    id: d.id, subjectId, type: d.type, number: d.number, issueDate: d.issueDate, expiryDate: d.expiryDate, verified: d.verified,
    verifiedBy: d.verifiedBy, verifiedAt: d.verifiedAt, hasScan: d.fileId !== null, scanStatus: d.fileId ? "clean" : null,
  });
  function loadMasters() {
    const subjects: Record<MasterSubject, Subject[]> = { company: [], subcontractor: [], client: [], direct_employee: [], indirect_employee: [] };
    const sponsorsById = new Map(db.sponsors.map((s) => [s.id, s]));
    for (const s of [...db.sponsors].sort((a, b) => a.legalName.localeCompare(b.legalName))) {
      if (s.kind === "own") subjects.company.push({ id: s.id, kind: "company", name: s.legalName, code: s.crNumber, status: s.status, engagement: null, sponsorName: null });
      else if (s.status === "active") subjects.subcontractor.push({ id: s.id, kind: "subcontractor", name: s.legalName, code: s.crNumber, status: s.status, engagement: null, sponsorName: null });
    }
    for (const c of [...db.clients].sort((a, b) => a.legalName.localeCompare(b.legalName))) {
      subjects.client.push({ id: c.id, kind: "client", name: c.legalName, code: c.code, status: c.status, engagement: null, sponsorName: null });
    }
    const engaged = new Map(db.engagements.map((e) => [e.workerId, e]));
    for (const w of db.workers.filter((x) => ACTIVE.has(x.status)).sort((a, b) => a.fullName.localeCompare(b.fullName))) {
      // A worker added in the demo is the company's own from the day they are recorded.
      const e = engaged.get(w.id) ?? { engagement: "own" as const, sponsorId: db.sponsors[0]!.id };
      const kind = engagementSubject(e.engagement);
      subjects[kind].push({ id: w.id, kind, name: w.fullName, code: w.code, status: w.status, engagement: e.engagement, sponsorName: sponsorsById.get(e.sponsorId)?.legalName ?? null });
    }
    return {
      subjects,
      workerDocs: db.docs.map((d) => registerDoc(d.workerId, { ...d, number: mask(d.number) })), // personal data: last 4 only
      orgDocs: db.orgDocs.map((d) => registerDoc((d.sponsorId ?? d.clientId)!, d)),
    };
  }
  const describeMaster = (m: MasterDefinition) => ({
    no: m.no, key: m.key, group: m.group, label: m.label, subject: m.subject, documentType: m.documentType,
    documentLabel: masterDocumentLabel(m), requiredOfAll: m.requiredOfAll,
  });
  const registerOf = (m: MasterDefinition, data: ReturnType<typeof loadMasters>) =>
    buildMasterRegister(m, data.subjects[m.subject], isWorkerMaster(m) ? data.workerDocs : data.orgDocs, today);

  /** FilesService.store: the type checked from the bytes, at most 15 MB; kept in memory for this visit. */
  function storeScan(body: unknown): StoredFile {
    const upload = (body ?? {}) as { bytes?: unknown; contentType?: string; fileName?: string };
    // isView, not instanceof: the bytes may come from another realm (a test's TextEncoder, a worker).
    const view = ArrayBuffer.isView(upload.bytes) ? new Uint8Array(upload.bytes.buffer, upload.bytes.byteOffset, upload.bytes.byteLength) : null;
    if (!view || view.length === 0) throw problem(415, "UNSUPPORTED_FILE", "Send the scan as the request body: a PDF, JPG, PNG or HEIC file.");
    if (view.length > MAX_FILE_BYTES) throw problem(413, "FILE_TOO_LARGE", "A scan can be at most 15 MB.");
    const mime = detectMime(view);
    if (!mime || mime !== (upload.contentType ?? "").split(";")[0]!.trim().toLowerCase()) {
      throw problem(415, "UNSUPPORTED_FILE", "Only PDF, JPG, PNG and HEIC scans are accepted, and the file must really be that type.");
    }
    let name = upload.fileName ?? "scan";
    try {
      name = decodeURIComponent(name);
    } catch {
      // Not percent-encoded: use it as sent.
    }
    // files.ts cleanFileName: no path, control or format characters; always ends in the real type's extension.
    const exts = ({ "application/pdf": ["pdf"], "image/jpeg": ["jpg", "jpeg"], "image/png": ["png"], "image/heic": ["heic", "heif"] } as Record<string, string[]>)[mime]!;
    const base = name.split(/[\\/]/).pop()!.replace(/[\p{Cc}\p{Cf}"]/gu, "").trim().slice(0, 200);
    const current = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1).toLowerCase() : "";
    name = !base ? `scan.${exts[0]}` : exts.includes(current) ? base : `${base.slice(0, 200 - exts[0]!.length - 1)}.${exts[0]}`;
    const file: StoredFile = { id: newId(9), bytes: view.slice(), mime, name };
    db.files.set(file.id, file);
    return file;
  }
  /** MastersService.attachScan: a new scan from someone who may not verify un-verifies the document. */
  async function attachScan(kind: "worker" | "organisation", doc: Doc | OrgDoc, body: unknown, actor: string) {
    const file = storeScan(body);
    const before = { ...doc };
    doc.fileId = file.id;
    if (!grantsOf(actor).includes("documents.verify")) Object.assign(doc, { verified: false, verifiedBy: null, verifiedAt: null });
    const view = (d: Doc | OrgDoc) => (kind === "worker" ? { ...d, number: mask(d.number) } : d);
    await record(actor, `${kind === "worker" ? "document" : "org_document"}.scan_attach`, kind === "worker" ? "worker_document" : "organisation_document", doc.id, view(before), { ...view(doc), file: { id: file.id, mime: file.mime, bytes: file.bytes.length, scanStatus: "clean" } });
    return { documentId: doc.id, fileId: file.id, mime: file.mime, bytes: file.bytes.length, scanStatus: "clean", originalName: file.name, verified: doc.verified };
  }
  async function openScan(kind: "worker" | "organisation", doc: Doc | OrgDoc, actor: string) {
    const file = doc.fileId ? db.files.get(doc.fileId) : undefined;
    if (!file) throw problem(404, "NO_SCAN", "No scan has been uploaded for this document.");
    await record(actor, `${kind === "worker" ? "document" : "org_document"}.scan_open`, kind === "worker" ? "worker_document" : "organisation_document", doc.id, null, { fileId: file.id });
    return { bytes: file.bytes, mime: file.mime };
  }
  const findDoc = (id: string) => {
    const d = db.docs.find((x) => x.id === parse(uuid, id));
    if (!d) throw notFound("Document");
    return d;
  };
  const findOrgDoc = (id: string) => {
    const d = db.orgDocs.find((x) => x.id === parse(uuid, id));
    if (!d) throw notFound("Document");
    return d;
  };

  type Handler = (m: RegExpMatchArray, body: unknown, actor: string, query: URLSearchParams) => unknown;
  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/api\/health$/, () => ({ ok: true })],
    ["GET", /^\/api\/workers$/, (_m, _b, _a, query) => {
      const q = parse(listWorkersSchema, Object.fromEntries(query));
      const all = allWithCompliance(q);
      const filtered = q.compliance ? all.filter((w) => w.compliance.state === q.compliance) : all;
      return { total: filtered.length, items: filtered.slice(q.offset, q.offset + q.limit) };
    }],
    ["POST", /^\/api\/workers$/, async (_m, body, actor) => {
      const input = parse(createWorkerSchema, body);
      const t = now();
      const worker: Worker = {
        id: newId(1), entityId: ENTITY, code: `W-${String(nextWorker++).padStart(6, "0")}`,
        fullName: input.fullName, fullNameAr: input.fullNameAr ?? null, nationality: input.nationality, trade: input.trade,
        status: input.status, phone: input.phone ?? null, dateOfBirth: input.dateOfBirth ?? null, joinedOn: input.joinedOn ?? null,
        createdAt: t, updatedAt: t,
      };
      db.workers.push(worker);
      await record(actor, "worker.create", "worker", worker.id, null, worker);
      return worker;
    }],
    ["GET", /^\/api\/workers\/([^/]+)$/, ([, id]) => {
      const w = findWorker(id!);
      const ds = docsOf(w.id).sort((a, b) => (a.expiryDate ?? "9999").localeCompare(b.expiryDate ?? "9999"));
      return {
        ...w,
        compliance: summariseWorkerCompliance(coreDocs(ds), today),
        documents: ds.map((d) => ({ ...shownDoc(d), renewal: d.expiryDate ? renewalStatus(d.expiryDate, today) : null })),
        leave: db.leave.filter((l) => l.workerId === w.id),
      };
    }],
    ["POST", /^\/api\/workers\/([^/]+)\/documents$/, async ([, id], body, actor) => {
      const w = findWorker(id!);
      const input = parse(addDocumentSchema, body);
      assertMayVerify(input.verified, actor);
      const t = now();
      const doc: Doc = {
        id: newId(2), entityId: ENTITY, workerId: w.id, type: input.type, number: input.number ?? null,
        issueDate: input.issueDate ?? null, expiryDate: input.expiryDate ?? null, verified: input.verified,
        verifiedBy: input.verified ? actor : null, verifiedAt: input.verified ? t : null, fileId: null, createdAt: t, updatedAt: t,
      };
      db.docs.push(doc);
      indexDoc(doc);
      await record(actor, "document.create", "worker_document", doc.id, null, shownDoc(doc));
      return shownDoc(doc);
    }],
    ["POST", /^\/api\/workers\/([^/]+)\/leave$/, async ([, id], body, actor) => {
      const w = findWorker(id!);
      const input = parse(addLeaveSchema, body);
      const leave: Leave = { id: newId(4), entityId: ENTITY, workerId: w.id, ...input, status: "approved", createdAt: now() };
      db.leave.push(leave);
      await record(actor, "leave.create", "leave", leave.id, null, leave);
      return leave;
    }],
    ["PATCH", /^\/api\/documents\/([^/]+)\/verify$/, async ([, id], _b, actor) => {
      if (actor === "anonymous") throw new ApiError(401, "A named user is required for this action");
      const doc = db.docs.find((d) => d.id === parse(uuid, id));
      if (!doc) throw notFound("Document");
      const before = shownDoc(doc);
      const t = now();
      Object.assign(doc, { verified: true, verifiedBy: actor, verifiedAt: t, updatedAt: t });
      await record(actor, "document.verify", "worker_document", doc.id, before, shownDoc(doc));
      return shownDoc(doc);
    }],
    ["POST", /^\/api\/compliance\/check$/, (_m, body) => {
      const input = parse(checkSchema, body);
      const w = findWorker(input.workerId);
      let site: { id: string; requiredDocuments: DocumentType[] } | undefined;
      if (input.siteId) {
        const row = db.sites.find((s) => s.id === input.siteId);
        if (!row) throw notFound("Site");
        site = { id: row.id, requiredDocuments: row.requiredDocuments };
      }
      return checkEligibility({
        worker: { id: w.id, status: w.status },
        documents: coreDocs(docsOf(w.id)),
        period: { from: input.from, to: input.to },
        today,
        site,
        leave: db.leave.filter((l) => l.workerId === w.id && l.status === "approved").map((l) => ({ from: l.fromDate, to: l.toDate })),
        overrides: db.overrides
          .filter((o) => o.workerId === w.id)
          .map((o) => ({ code: o.code, documentType: (o.documentType ?? undefined) as DocumentType | undefined, validUntil: o.validUntil, approvedBy: o.approvedBy, reason: o.reason })),
      });
    }],
    ["POST", /^\/api\/workers\/([^/]+)\/overrides$/, async ([, id], body, approvedBy) => {
      const w = findWorker(id!);
      const input = parse(overrideSchema, body);
      if (input.validUntil < today) throw new ApiError(400, "An override cannot end in the past");
      const row: Override = { id: newId(5), entityId: ENTITY, workerId: w.id, code: input.code, documentType: input.documentType ?? null, validUntil: input.validUntil, approvedBy, reason: input.reason, createdAt: now() };
      db.overrides.push(row);
      await record(approvedBy, "compliance.override", "worker", w.id, null, row);
      return row;
    }],
    ["GET", /^\/api\/compliance\/renewals$/, () => {
      const active = new Map(db.workers.filter((w) => w.status !== "exited").map((w) => [w.id, w]));
      const rows = db.docs.flatMap((d) => {
        const w = active.get(d.workerId);
        return w ? [{ id: d.id, workerId: w.id, type: d.type, expiryDate: d.expiryDate, workerName: w.fullName, workerCode: w.code }] : [];
      });
      return { items: buildRenewalQueue(rows, today) };
    }],
    ["GET", /^\/api\/dashboard\/summary$/, () => {
      const all = allWithCompliance();
      const byStatus: Record<string, number> = {};
      const byCompliance = { ok: 0, due: 0, incomplete: 0, expired: 0 };
      let expiringIn30Days = 0;
      for (const w of all) {
        byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
        byCompliance[w.compliance.state] += 1;
        const next = w.compliance.nextExpiry;
        if (next && next.daysLeft >= 0 && daysBetween(today, next.expiryDate) <= 30) expiringIn30Days += 1;
      }
      return { today, headcount: all.length, byStatus, byCompliance, expiringIn30Days };
    }],
    ["GET", /^\/api\/masters$/, () => {
      const data = loadMasters();
      return {
        today,
        groups: MASTER_GROUPS.map((group) => ({
          group,
          label: MASTER_GROUP_LABELS[group],
          masters: MASTERS.filter((m) => m.group === group).map((m) => ({ ...describeMaster(m), summary: summariseMaster(registerOf(m, data)) })),
        })),
      };
    }],
    ["GET", /^\/api\/masters\/([^/]+)$/, ([, key]) => {
      const master = masterByKey(decodeURIComponent(key!));
      if (!master) throw problem(404, "UNKNOWN_MASTER", `There is no master called "${key}".`);
      const rows = registerOf(master, loadMasters());
      return { today, master: describeMaster(master), summary: summariseMaster(rows), rows };
    }],
    ["GET", /^\/api\/clients$/, () => ({ items: [...db.clients].sort((a, b) => a.legalName.localeCompare(b.legalName)) })],
    ["POST", /^\/api\/clients$/, async (_m, body, actor) => {
      const input = parse(createClientSchema, body);
      if (input.crNumber && db.clients.some((c) => c.crNumber?.toLowerCase() === input.crNumber!.toLowerCase())) {
        throw problem(409, "CLIENT_EXISTS", "A client with that CR number is already recorded.");
      }
      const client: Client = {
        id: newId(7), code: `C-${String(db.clients.length + 1).padStart(5, "0")}`, legalName: input.legalName, crNumber: input.crNumber ?? null,
        vatNumber: input.vatNumber ?? null, paymentTermsDays: input.paymentTermsDays, creditLimit: input.creditLimit ?? null, status: input.status,
      };
      db.clients.push(client);
      await record(actor, "client.create", "client", client.id, null, client);
      return client;
    }],
    ["POST", /^\/api\/sponsors$/, async (_m, body, actor) => {
      const input = parse(createSponsorSchema, body);
      if (input.crNumber && db.sponsors.some((s) => s.crNumber?.toLowerCase() === input.crNumber!.toLowerCase())) {
        throw problem(409, "SPONSOR_EXISTS", "A sponsor with that CR number is already recorded.");
      }
      const sponsor: Sponsor = { id: newId(6), kind: "external", legalName: input.legalName, crNumber: input.crNumber ?? null, molEstablishmentNo: input.molEstablishmentNo ?? null, status: "active" };
      db.sponsors.push(sponsor);
      await record(actor, "sponsor.create", "sponsor", sponsor.id, null, sponsor);
      return sponsor;
    }],
    ["POST", /^\/api\/organisation-documents$/, async (_m, body, actor) => {
      const input = parse(addOrganisationDocumentSchema, body);
      assertMayVerify(input.verified, actor);
      const s = input.subject;
      let owner: { sponsorId: string | null; clientId: string | null };
      if (s.kind === "company") {
        assertMayManageCompany(actor);
        owner = { sponsorId: db.sponsors.find((x) => x.kind === "own")!.id, clientId: null };
      } else if (s.kind === "subcontractor") {
        const sponsor = db.sponsors.find((x) => x.id === s.sponsorId);
        if (!sponsor) throw notFound("Sub-contractor");
        if (sponsor.kind !== "external") throw problem(422, "NOT_A_SUBCONTRACTOR", "The company's own papers are recorded as company documents.");
        owner = { sponsorId: sponsor.id, clientId: null };
      } else {
        if (!db.clients.some((x) => x.id === s.clientId)) throw notFound("Client");
        owner = { sponsorId: null, clientId: s.clientId };
      }
      const t = now();
      const doc: OrgDoc = {
        id: newId(8), ...owner, type: input.type, number: input.number ?? null, issueDate: input.issueDate ?? null, expiryDate: input.expiryDate ?? null,
        verified: input.verified, verifiedBy: input.verified ? actor : null, verifiedAt: input.verified ? t : null, fileId: null, createdBy: actor, createdAt: t,
      };
      db.orgDocs.push(doc);
      await record(actor, "org_document.create", "organisation_document", doc.id, null, doc);
      return doc;
    }],
    ["PATCH", /^\/api\/organisation-documents\/([^/]+)\/verify$/, async ([, id], _b, actor) => {
      const doc = findOrgDoc(id!);
      if (doc.verified) throw problem(409, "ALREADY_VERIFIED", `Already verified by ${doc.verifiedBy}.`); // the first verifier stays
      const before = { ...doc };
      Object.assign(doc, { verified: true, verifiedBy: actor, verifiedAt: now() });
      await record(actor, "org_document.verify", "organisation_document", doc.id, before, doc);
      return doc;
    }],
    ["POST", /^\/api\/organisation-documents\/([^/]+)\/scan$/, ([, id], body, actor) => {
      const doc = findOrgDoc(id!);
      if (doc.sponsorId === db.sponsors.find((x) => x.kind === "own")!.id) assertMayManageCompany(actor);
      return attachScan("organisation", doc, body, actor);
    }],
    ["GET", /^\/api\/organisation-documents\/([^/]+)\/scan$/, ([, id], _b, actor) => openScan("organisation", findOrgDoc(id!), actor)],
    ["POST", /^\/api\/documents\/([^/]+)\/scan$/, ([, id], body, actor) => attachScan("worker", findDoc(id!), body, actor)],
    ["GET", /^\/api\/documents\/([^/]+)\/scan$/, ([, id], _b, actor) => openScan("worker", findDoc(id!), actor)],
    ["GET", /^\/api\/sites$/, () => ({ items: [...db.sites].sort((a, b) => a.name.localeCompare(b.name)) })],
    ["GET", /^\/api\/audit$/, (_m, _b, _a, query) => {
      const { subjectId } = parse(z.object({ subjectId: z.string().min(1) }), Object.fromEntries(query));
      return { items: db.audit.filter((e) => e.subjectId === subjectId) };
    }],
    ["GET", /^\/api\/audit\/verify$/, async () => {
      let prevHash = GENESIS;
      for (const row of db.audit) {
        if (row.prevHash !== prevHash || row.hash !== (await hashOf(prevHash, row))) {
          return { intact: false, checked: db.audit.length, firstBrokenId: row.id };
        }
        prevHash = row.hash;
      }
      return { intact: true, checked: db.audit.length, firstBrokenId: null };
    }],
  ];

  return {
    /** Answer one request like the API would: the parsed JSON body, or an `ApiError`. */
    async handle<T>(method: string, url: string, body: unknown, actor: string): Promise<T> {
      const [path = "", search = ""] = url.split("?");
      for (const [m, pattern, handler] of routes) {
        const match = m === method ? path.match(pattern) : null;
        // structuredClone: callers get copies, as they would over HTTP, never the live records.
        if (match) return structuredClone(await handler(match, body, actor, new URLSearchParams(search))) as T;
      }
      throw new ApiError(404, `Cannot ${method} ${path}`);
    },
  };
}

let shared: ReturnType<typeof createDemoServer> | undefined;
/** The one in-memory server for this browser tab (created on first use). */
export const demoServer = () => (shared ??= createDemoServer());
