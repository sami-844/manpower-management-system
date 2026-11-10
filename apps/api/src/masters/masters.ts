import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import {
  buildMasterRegister,
  engagementSubject,
  isWorkerMaster,
  MASTER_GROUP_LABELS,
  MASTER_GROUPS,
  masterByKey,
  masterDocumentLabel,
  MASTERS,
  ORGANISATION_DOCUMENT_TYPES,
  summariseMaster,
  type MasterDefinition,
  type MasterSubject,
} from "@mms/core";
import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { RequirePermission } from "../auth/permissions";
import { Actor, assertMayVerify, Grants } from "../common/actor";
import { CLOCK, type Clock } from "../common/clock";
import { maskNumber } from "../common/mask";
import { calendarDate, parse, parseId, uuid } from "../common/validation";
import { DB, type Database, type Orm } from "../db/client";
import { clients, files, organisationDocuments, sponsors, workerDocuments, workers, workerSponsorships } from "../db/schema";
import { FilesService, SCAN_HEADERS, type Upload } from "../files/files";
import { ensureOwnSponsor } from "../sponsors/sponsors";

/**
 * Document masters (PRD 4.19, TR-ENG-15, A26-A30): the client register, the papers of the company,
 * its sub-contractors and its clients, scans for every document, and the eighteen registers.
 */

type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];
const problem = (status: number, code: string, message: string) => new HttpException({ code, message }, status);

/** Workers a master covers: everyone who can be rostered today. */
const ACTIVE_WORKER_STATUSES = ["available", "deployed", "on_leave"];

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
};

const upload = (req: Request): Upload => ({
  bytes: req.body,
  contentType: req.headers["content-type"],
  fileName: typeof req.headers["x-file-name"] === "string" ? req.headers["x-file-name"] : undefined,
});

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

const decimal = z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, "Must be an amount in OMR with at most 3 decimals");

export const createClientSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  crNumber: z.string().trim().min(3).max(30).optional(),
  vatNumber: z.string().trim().min(3).max(30).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
  creditLimit: decimal.optional(),
  status: z.enum(["prospect", "active", "on_hold"]).default("active"),
});

export const updateClientSchema = z
  .object({
    legalName: z.string().trim().min(2).max(200),
    crNumber: z.string().trim().min(3).max(30).nullable(),
    vatNumber: z.string().trim().min(3).max(30).nullable(),
    paymentTermsDays: z.number().int().min(0).max(365),
    creditLimit: decimal.nullable(),
    status: z.enum(["prospect", "active", "on_hold"]),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });

const subjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("company") }),
  z.object({ kind: z.literal("subcontractor"), sponsorId: uuid }),
  z.object({ kind: z.literal("client"), clientId: uuid }),
]);

export const addOrganisationDocumentSchema = z
  .object({
    subject: subjectSchema,
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

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

type ClientRow = typeof clients.$inferSelect;
type OrgDocRow = typeof organisationDocuments.$inferSelect;

interface Subject {
  id: string;
  kind: MasterSubject;
  name: string;
  code: string | null;
  status: string | null;
  engagement: string | null;
  sponsorName: string | null;
}

interface RegisterDocument {
  id: string;
  subjectId: string;
  type: string;
  number: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  verified: boolean;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  hasScan: boolean;
  scanStatus: string | null;
}

const clientView = (c: ClientRow) => ({
  id: c.id,
  code: c.code,
  legalName: c.legalName,
  crNumber: c.crNumber,
  vatNumber: c.vatNumber,
  paymentTermsDays: c.paymentTermsDays,
  creditLimit: c.creditLimit,
  status: c.status,
});

@Injectable()
export class MastersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  // ----- Clients ------------------------------------------------------------------------------

  async listClients() {
    const rows = await this.db.orm.select().from(clients).orderBy(asc(clients.legalName));
    return { items: rows.map(clientView) };
  }

  async createClient(input: z.infer<typeof createClientSchema>, actor: string) {
    try {
      return await this.db.orm.transaction(async (tx) => {
        const [row] = await tx.insert(clients).values({ ...input, createdBy: actor, updatedBy: actor }).returning();
        await this.audit.record(tx, { actor, action: "client.create", subjectType: "client", subjectId: row!.id, before: null, after: row });
        return clientView(row!);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw problem(HttpStatus.CONFLICT, "CLIENT_EXISTS", "A client with that CR number is already recorded.");
      throw e;
    }
  }

  async updateClient(id: string, input: z.infer<typeof updateClientSchema>, actor: string) {
    try {
      return await this.db.orm.transaction(async (tx) => {
        const [before] = await tx.select().from(clients).where(eq(clients.id, id)).for("update");
        if (!before) throw new NotFoundException("Client not found");
        const [after] = await tx
          .update(clients)
          .set({ ...input, updatedBy: actor, updatedAt: sql`now()` })
          .where(eq(clients.id, id))
          .returning();
        await this.audit.record(tx, { actor, action: "client.update", subjectType: "client", subjectId: id, before, after });
        return clientView(after!);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw problem(HttpStatus.CONFLICT, "CLIENT_EXISTS", "A client with that CR number is already recorded.");
      throw e;
    }
  }

  // ----- Organisation documents ---------------------------------------------------------------

  private async owner(tx: Tx, subject: z.infer<typeof subjectSchema>, actor: string) {
    if (subject.kind === "company") return { sponsorId: (await ensureOwnSponsor(tx, actor)).id, clientId: null };
    if (subject.kind === "subcontractor") {
      const [s] = await tx.select().from(sponsors).where(eq(sponsors.id, subject.sponsorId));
      if (!s) throw new NotFoundException("Sub-contractor not found");
      if (s.kind !== "external") {
        throw problem(HttpStatus.UNPROCESSABLE_ENTITY, "NOT_A_SUBCONTRACTOR", "The company's own papers are recorded as company documents.");
      }
      return { sponsorId: s.id, clientId: null };
    }
    const [c] = await tx.select({ id: clients.id }).from(clients).where(eq(clients.id, subject.clientId));
    if (!c) throw new NotFoundException("Client not found");
    return { sponsorId: null, clientId: c.id };
  }

  async addOrganisationDocument(input: z.infer<typeof addOrganisationDocumentSchema>, actor: string) {
    return this.db.orm.transaction(async (tx) => {
      const owner = await this.owner(tx, input.subject, actor);
      const [doc] = await tx
        .insert(organisationDocuments)
        .values({
          ...owner,
          type: input.type,
          number: input.number,
          issueDate: input.issueDate,
          expiryDate: input.expiryDate ?? null,
          verified: input.verified,
          verifiedBy: input.verified ? actor : null,
          verifiedAt: input.verified ? new Date() : null,
          createdBy: actor,
        })
        .returning();
      await this.audit.record(tx, {
        actor,
        action: "org_document.create",
        subjectType: "organisation_document",
        subjectId: doc!.id,
        before: null,
        after: doc,
      });
      return doc!;
    });
  }

  async verifyOrganisationDocument(id: string, actor: string) {
    return this.db.orm.transaction(async (tx) => {
      const [before] = await tx.select().from(organisationDocuments).where(eq(organisationDocuments.id, id)).for("update");
      if (!before) throw new NotFoundException("Document not found");
      const [after] = await tx
        .update(organisationDocuments)
        .set({ verified: true, verifiedBy: actor, verifiedAt: new Date(), updatedAt: sql`now()` })
        .where(eq(organisationDocuments.id, id))
        .returning();
      await this.audit.record(tx, { actor, action: "org_document.verify", subjectType: "organisation_document", subjectId: id, before, after });
      return after!;
    });
  }

  // ----- Scans --------------------------------------------------------------------------------

  /**
   * Attach a new scan to a document. The previous scan stays stored; the audit trail keeps both.
   * Verification vouches for a scan, so a new scan from someone who may not verify (operations)
   * un-verifies the document until HR/PRO check it again.
   */
  async attachScan(kind: "worker" | "organisation", documentId: string, file: Upload, actor: string, grants: ReadonlySet<string>) {
    const table = kind === "worker" ? workerDocuments : organisationDocuments;
    return this.db.orm.transaction(async (tx) => {
      const [before] = await tx.select().from(table).where(eq(table.id, documentId)).for("update");
      if (!before) throw new NotFoundException("Document not found");
      const stored = await this.files.store(tx, file, actor);
      const keepVerified = grants.has("documents.verify");
      const [after] = await tx
        .update(table)
        .set(keepVerified ? { fileId: stored.id, updatedAt: sql`now()` } : { fileId: stored.id, verified: false, verifiedBy: null, verifiedAt: null, updatedAt: sql`now()` })
        .where(eq(table.id, documentId))
        .returning();
      const view = (d: typeof before) => (kind === "worker" ? { ...d, number: maskNumber(d.number) } : d);
      await this.audit.record(tx, {
        actor,
        action: kind === "worker" ? "document.scan_attach" : "org_document.scan_attach",
        subjectType: kind === "worker" ? "worker_document" : "organisation_document",
        subjectId: documentId,
        before: view(before),
        after: { ...view(after!), file: { id: stored.id, sha256: stored.sha256, mime: stored.mime, bytes: stored.bytes, scanStatus: stored.scanStatus } },
      });
      return {
        documentId,
        fileId: stored.id,
        mime: stored.mime,
        bytes: stored.bytes,
        scanStatus: stored.scanStatus,
        originalName: stored.originalName,
        verified: after!.verified,
      };
    });
  }

  /** Open a document's scan; every opening is audited (PRD 4.19, TR-SEC-07). */
  async openScan(kind: "worker" | "organisation", documentId: string, actor: string) {
    const table = kind === "worker" ? workerDocuments : organisationDocuments;
    const [doc] = await this.db.orm.select({ fileId: table.fileId }).from(table).where(eq(table.id, documentId));
    if (!doc) throw new NotFoundException("Document not found");
    if (!doc.fileId) throw problem(HttpStatus.NOT_FOUND, "NO_SCAN", "No scan has been uploaded for this document.");
    const opened = await this.files.open(doc.fileId);
    await this.db.orm.transaction((tx) =>
      this.audit.record(tx, {
        actor,
        action: kind === "worker" ? "document.scan_open" : "org_document.scan_open",
        subjectType: kind === "worker" ? "worker_document" : "organisation_document",
        subjectId: documentId,
        before: null,
        after: { fileId: opened.row.id, sha256: opened.row.sha256 },
      }),
    );
    return opened.body;
  }

  // ----- Masters ------------------------------------------------------------------------------

  /** Everyone and everything the masters cover today, loaded once (≈700 workers: cheap at this scale). */
  private async load() {
    const today = this.clock.today();
    const workerTypes = [...new Set(MASTERS.filter(isWorkerMaster).map((m) => m.documentType))];
    const [sponsorRows, clientRows, workerRows, workerDocs, orgDocs] = await Promise.all([
      this.db.orm.select().from(sponsors).orderBy(asc(sponsors.legalName)),
      this.db.orm.select().from(clients).orderBy(asc(clients.legalName)),
      this.db.orm
        .select({ w: workers, engagement: workerSponsorships.engagement, sponsorName: sponsors.legalName })
        .from(workers)
        .innerJoin(
          workerSponsorships,
          and(
            eq(workerSponsorships.workerId, workers.id),
            lte(workerSponsorships.validFrom, today),
            or(isNull(workerSponsorships.validTo), gte(workerSponsorships.validTo, today)),
          ),
        )
        .leftJoin(sponsors, eq(sponsors.id, workerSponsorships.sponsorId))
        .where(inArray(workers.status, ACTIVE_WORKER_STATUSES))
        .orderBy(asc(workers.fullName)),
      this.db.orm
        .select({ d: workerDocuments, scanStatus: files.scanStatus })
        .from(workerDocuments)
        .leftJoin(files, eq(files.id, workerDocuments.fileId))
        .where(inArray(workerDocuments.type, workerTypes)),
      this.db.orm
        .select({ d: organisationDocuments, scanStatus: files.scanStatus })
        .from(organisationDocuments)
        .leftJoin(files, eq(files.id, organisationDocuments.fileId)),
    ]);

    const subjects: Record<MasterSubject, Subject[]> = {
      company: [],
      subcontractor: [],
      client: [],
      direct_employee: [],
      indirect_employee: [],
    };
    for (const s of sponsorRows) {
      if (s.kind === "own") subjects.company.push({ id: s.id, kind: "company", name: s.legalName, code: s.crNumber, status: s.status, engagement: null, sponsorName: null });
      else if (s.status === "active") subjects.subcontractor.push({ id: s.id, kind: "subcontractor", name: s.legalName, code: s.crNumber, status: s.status, engagement: null, sponsorName: null });
    }
    for (const c of clientRows) {
      subjects.client.push({ id: c.id, kind: "client", name: c.legalName, code: c.code, status: c.status, engagement: null, sponsorName: null });
    }
    for (const r of workerRows) {
      const kind = engagementSubject(r.engagement as Parameters<typeof engagementSubject>[0]);
      subjects[kind].push({ id: r.w.id, kind, name: r.w.fullName, code: r.w.code, status: r.w.status, engagement: r.engagement, sponsorName: r.sponsorName });
    }

    const workerDocuments_: RegisterDocument[] = workerDocs.map(({ d, scanStatus }) => ({
      id: d.id,
      subjectId: d.workerId,
      type: d.type,
      number: maskNumber(d.number), // personal data: last 4 only (TR-SEC-07)
      issueDate: d.issueDate,
      expiryDate: d.expiryDate,
      verified: d.verified,
      verifiedBy: d.verifiedBy,
      verifiedAt: d.verifiedAt,
      hasScan: d.fileId !== null,
      scanStatus,
    }));
    const orgDocuments: RegisterDocument[] = orgDocs.map(({ d, scanStatus }: { d: OrgDocRow; scanStatus: string | null }) => ({
      id: d.id,
      subjectId: (d.sponsorId ?? d.clientId)!,
      type: d.type,
      number: d.number,
      issueDate: d.issueDate,
      expiryDate: d.expiryDate,
      verified: d.verified,
      verifiedBy: d.verifiedBy,
      verifiedAt: d.verifiedAt,
      hasScan: d.fileId !== null,
      scanStatus,
    }));
    return { today, subjects, workerDocuments: workerDocuments_, orgDocuments };
  }

  private register(master: MasterDefinition, data: Awaited<ReturnType<MastersService["load"]>>) {
    const docs = isWorkerMaster(master) ? data.workerDocuments : data.orgDocuments;
    return buildMasterRegister(master, data.subjects[master.subject], docs, data.today);
  }

  private describe(master: MasterDefinition) {
    return {
      no: master.no,
      key: master.key,
      group: master.group,
      label: master.label,
      subject: master.subject,
      documentType: master.documentType,
      documentLabel: masterDocumentLabel(master),
      requiredOfAll: master.requiredOfAll,
    };
  }

  /** The eighteen masters in their three groups, each with its counts (S-44). */
  async overview() {
    const data = await this.load();
    return {
      today: data.today,
      groups: MASTER_GROUPS.map((group) => ({
        group,
        label: MASTER_GROUP_LABELS[group],
        masters: MASTERS.filter((m) => m.group === group).map((m) => ({ ...this.describe(m), summary: summariseMaster(this.register(m, data)) })),
      })),
    };
  }

  /** One master's register (S-45): every subject it covers, its latest document and state. */
  async master(key: string) {
    const master = masterByKey(key);
    if (!master) throw problem(HttpStatus.NOT_FOUND, "UNKNOWN_MASTER", `There is no master called "${key}".`);
    const data = await this.load();
    const rows = this.register(master, data);
    return { today: data.today, master: this.describe(master), summary: summariseMaster(rows), rows };
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

@Controller("api")
export class MastersController {
  constructor(@Inject(MastersService) private readonly masters: MastersService) {}

  @RequirePermission("masters.read")
  @Get("masters")
  overview() {
    return this.masters.overview();
  }

  @RequirePermission("masters.read")
  @Get("masters/:key")
  master(@Param("key") key: string) {
    return this.masters.master(key);
  }

  @RequirePermission("clients.read")
  @Get("clients")
  listClients() {
    return this.masters.listClients();
  }

  @RequirePermission("clients.manage")
  @Post("clients")
  createClient(@Body() body: unknown, @Actor() actor: string) {
    return this.masters.createClient(parse(createClientSchema, body), actor);
  }

  @RequirePermission("clients.manage")
  @Patch("clients/:id")
  updateClient(@Param("id") id: string, @Body() body: unknown, @Actor() actor: string) {
    return this.masters.updateClient(parseId(id), parse(updateClientSchema, body), actor);
  }

  @RequirePermission("org_documents.manage")
  @Post("organisation-documents")
  addOrganisationDocument(@Body() body: unknown, @Actor() actor: string, @Grants() grants: ReadonlySet<string>) {
    const input = parse(addOrganisationDocumentSchema, body);
    assertMayVerify(input.verified, grants);
    return this.masters.addOrganisationDocument(input, actor);
  }

  @RequirePermission("documents.verify")
  @Patch("organisation-documents/:id/verify")
  @HttpCode(200)
  verifyOrganisationDocument(@Param("id") id: string, @Actor() actor: string) {
    return this.masters.verifyOrganisationDocument(parseId(id), actor);
  }

  @RequirePermission("org_documents.manage")
  @Post("organisation-documents/:id/scan")
  attachOrganisationScan(@Param("id") id: string, @Req() req: Request, @Actor() actor: string, @Grants() grants: ReadonlySet<string>) {
    return this.masters.attachScan("organisation", parseId(id), upload(req), actor, grants);
  }

  @RequirePermission("masters.read")
  @Get("organisation-documents/:id/scan")
  async openOrganisationScan(@Param("id") id: string, @Res({ passthrough: true }) res: Response, @Actor() actor: string) {
    const body = await this.masters.openScan("organisation", parseId(id), actor);
    res.set(SCAN_HEADERS);
    return body;
  }

  @RequirePermission("documents.create")
  @Post("documents/:id/scan")
  attachWorkerScan(@Param("id") id: string, @Req() req: Request, @Actor() actor: string, @Grants() grants: ReadonlySet<string>) {
    return this.masters.attachScan("worker", parseId(id), upload(req), actor, grants);
  }

  /** A worker's passport or ID scan shows personal data in full (TR-SEC-07). */
  @RequirePermission("pii.view")
  @Get("documents/:id/scan")
  async openWorkerScan(@Param("id") id: string, @Res({ passthrough: true }) res: Response, @Actor() actor: string) {
    const body = await this.masters.openScan("worker", parseId(id), actor);
    res.set(SCAN_HEADERS);
    return body;
  }
}

@Module({ controllers: [MastersController], providers: [MastersService] })
export class MastersModule {}
