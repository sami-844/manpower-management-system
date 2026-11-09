import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  DOCUMENT_TYPES,
  ENGAGEMENTS,
  renewalStatus,
  summariseWorkerCompliance,
  WORKER_STATUSES,
  type DocumentType,
  type WorkerComplianceState,
  type WorkerDocument,
} from "@mms/core";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { CLOCK, type Clock } from "../common/clock";
import { maskNumber } from "../common/mask";
import { calendarDate } from "../common/validation";
import { DB, type Database } from "../db/client";
import { leavePeriods, sponsors, workerDocuments, workers, workerSponsorships } from "../db/schema";
import { engagementSchema, isUnauthorised, recordEngagement } from "../sponsors/sponsors";

export const createWorkerSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  fullNameAr: z.string().trim().max(120).optional(),
  nationality: z.string().trim().min(2).max(60),
  trade: z.string().trim().min(2).max(60),
  status: z.enum(WORKER_STATUSES).default("available"),
  phone: z.string().trim().max(30).optional(),
  dateOfBirth: calendarDate.optional(),
  joinedOn: calendarDate.optional(),
  // How the worker comes to work for the company (PRD 4.18); the company's own unless said otherwise.
  engagement: engagementSchema.default({ engagement: "own" }),
});

export const addDocumentSchema = z
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

export const listWorkersSchema = z.object({
  search: z.string().trim().max(60).optional(),
  status: z.enum(WORKER_STATUSES).optional(),
  compliance: z.enum(["ok", "due", "incomplete", "expired"]).optional(),
  engagement: z.enum(ENGAGEMENTS).optional(),
  sponsorId: z.string().uuid().optional(),
  unauthorised: z.enum(["true", "false"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

export const addLeaveSchema = z
  .object({ fromDate: calendarDate, toDate: calendarDate })
  .refine((l) => l.fromDate <= l.toDate, { message: "Leave must end on or after it starts", path: ["toDate"] });

type DocRow = typeof workerDocuments.$inferSelect;

function asCoreDocument(d: DocRow): WorkerDocument {
  return { type: d.type as DocumentType, expiryDate: d.expiryDate, verified: d.verified };
}

@Injectable()
export class WorkersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async create(input: z.infer<typeof createWorkerSchema>, actor: string) {
    const { engagement, ...fields } = input;
    return this.db.orm.transaction(async (tx) => {
      const [worker] = await tx.insert(workers).values(fields).returning();
      await this.audit.record(tx, {
        actor,
        action: "worker.create",
        subjectType: "worker",
        subjectId: worker!.id,
        before: null,
        after: worker,
      });
      const current = await recordEngagement(tx, this.audit, worker!.id, { ...engagement, validFrom: fields.joinedOn ?? this.clock.today() }, actor);
      return { ...worker!, engagement: current };
    });
  }

  /** Each worker's engagement today, with the sponsor's name (PRD 4.18). */
  private async currentEngagements(workerIds: string[]) {
    if (!workerIds.length) return new Map<string, { engagement: string; sponsorId: string | null; sponsorName: string | null; isUnauthorised: boolean }>();
    const today = this.clock.today();
    const rows = await this.db.orm
      .select({ s: workerSponsorships, sponsorName: sponsors.legalName })
      .from(workerSponsorships)
      .leftJoin(sponsors, eq(sponsors.id, workerSponsorships.sponsorId))
      .where(
        and(
          inArray(workerSponsorships.workerId, workerIds),
          lte(workerSponsorships.validFrom, today),
          or(isNull(workerSponsorships.validTo), gte(workerSponsorships.validTo, today)),
        ),
      );
    return new Map(
      rows.map((r) => [
        r.s.workerId,
        { engagement: r.s.engagement, sponsorId: r.s.sponsorId, sponsorName: r.sponsorName, isUnauthorised: isUnauthorised(r.s.engagement, r.s.authorisationRef) },
      ]),
    );
  }

  async list(query: z.infer<typeof listWorkersSchema>) {
    const all = await this.allWithCompliance(query);
    const filtered = all.filter(
      (w) =>
        (!query.compliance || w.compliance.state === query.compliance) &&
        (!query.engagement || w.engagement?.engagement === query.engagement) &&
        (!query.sponsorId || w.engagement?.sponsorId === query.sponsorId) &&
        (!query.unauthorised || (w.engagement?.isUnauthorised ?? false) === (query.unauthorised === "true")),
    );
    return { total: filtered.length, items: filtered.slice(query.offset, query.offset + query.limit) };
  }

  /** Every matching worker with their compliance summary (≈700 rows: cheap at this scale). */
  async allWithCompliance(query: { search?: string; status?: string } = {}) {
    const filters: SQL[] = [];
    if (query.status) filters.push(eq(workers.status, query.status));
    if (query.search) {
      const term = `%${query.search.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
      filters.push(or(ilike(workers.fullName, term), ilike(workers.code, term))!);
    }
    const rows = await this.db.orm
      .select()
      .from(workers)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(workers.fullName));

    const docs = rows.length
      ? await this.db.orm.select().from(workerDocuments).where(inArray(workerDocuments.workerId, rows.map((r) => r.id)))
      : [];
    const docsByWorker = Map.groupBy(docs, (d) => d.workerId);
    const engagements = await this.currentEngagements(rows.map((r) => r.id));
    const today = this.clock.today();

    return rows.map((w) => ({
      id: w.id,
      code: w.code,
      fullName: w.fullName,
      nationality: w.nationality,
      trade: w.trade,
      status: w.status,
      compliance: summariseWorkerCompliance((docsByWorker.get(w.id) ?? []).map(asCoreDocument), today),
      engagement: engagements.get(w.id) ?? null,
    }));
  }

  async get(id: string) {
    const [worker] = await this.db.orm.select().from(workers).where(eq(workers.id, id));
    if (!worker) throw new NotFoundException("Worker not found");
    const docs = await this.db.orm
      .select()
      .from(workerDocuments)
      .where(eq(workerDocuments.workerId, id))
      .orderBy(asc(workerDocuments.expiryDate));
    const leave = await this.db.orm.select().from(leavePeriods).where(eq(leavePeriods.workerId, id));
    const today = this.clock.today();
    return {
      ...worker,
      engagement: (await this.currentEngagements([id])).get(id) ?? null,
      compliance: summariseWorkerCompliance(docs.map(asCoreDocument), today),
      documents: docs.map((d) => ({
        ...d,
        number: maskNumber(d.number),
        renewal: d.expiryDate ? renewalStatus(d.expiryDate, today) : null,
      })),
      leave,
    };
  }

  async exists(id: string): Promise<void> {
    const [row] = await this.db.orm.select({ id: workers.id }).from(workers).where(eq(workers.id, id));
    if (!row) throw new NotFoundException("Worker not found");
  }

  async addDocument(workerId: string, input: z.infer<typeof addDocumentSchema>, actor: string) {
    await this.exists(workerId);
    return this.db.orm.transaction(async (tx) => {
      const [doc] = await tx
        .insert(workerDocuments)
        .values({
          workerId,
          type: input.type,
          number: input.number,
          issueDate: input.issueDate,
          expiryDate: input.expiryDate ?? null,
          verified: input.verified,
          verifiedBy: input.verified ? actor : null,
          verifiedAt: input.verified ? new Date() : null,
        })
        .returning();
      await this.audit.record(tx, {
        actor,
        action: "document.create",
        subjectType: "worker_document",
        subjectId: doc!.id,
        before: null,
        after: { ...doc, number: maskNumber(doc!.number) },
      });
      return { ...doc!, number: maskNumber(doc!.number) };
    });
  }

  async verifyDocument(documentId: string, actor: string) {
    return this.db.orm.transaction(async (tx) => {
      const [before] = await tx.select().from(workerDocuments).where(eq(workerDocuments.id, documentId)).for("update");
      if (!before) throw new NotFoundException("Document not found");
      const [after] = await tx
        .update(workerDocuments)
        .set({ verified: true, verifiedBy: actor, verifiedAt: new Date(), updatedAt: sql`now()` })
        .where(eq(workerDocuments.id, documentId))
        .returning();
      await this.audit.record(tx, {
        actor,
        action: "document.verify",
        subjectType: "worker_document",
        subjectId: documentId,
        before: { ...before, number: maskNumber(before.number) },
        after: { ...after, number: maskNumber(after!.number) },
      });
      return { ...after!, number: maskNumber(after!.number) };
    });
  }

  async addLeave(workerId: string, input: z.infer<typeof addLeaveSchema>, actor: string) {
    await this.exists(workerId);
    return this.db.orm.transaction(async (tx) => {
      const [leave] = await tx.insert(leavePeriods).values({ workerId, ...input }).returning();
      await this.audit.record(tx, {
        actor,
        action: "leave.create",
        subjectType: "leave",
        subjectId: leave!.id,
        before: null,
        after: leave,
      });
      return leave!;
    });
  }
}

export type WorkerListItem = Awaited<ReturnType<WorkersService["list"]>>["items"][number];
export type { WorkerComplianceState };
