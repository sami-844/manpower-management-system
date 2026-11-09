import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import {
  buildRenewalQueue,
  checkEligibility,
  daysBetween,
  type BlockerCode,
  type DocumentType,
  type Engagement,
  type Override,
  type WorkerStatus,
} from "@mms/core";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { CLOCK, type Clock } from "../common/clock";
import { calendarDate, uuid } from "../common/validation";
import { DB, type Database } from "../db/client";
import type { Principal } from "../auth/auth.service";
import { complianceOverrides, leavePeriods, sites, workerDocuments, workers, workerSponsorships } from "../db/schema";
import { readPolicy } from "../sponsors/sponsors";
import { WorkersService } from "../workers/workers.service";

const BLOCKER_CODES = [
  "MISSING_DOCUMENT",
  "DOCUMENT_EXPIRED",
  "DOCUMENT_EXPIRES_DURING_PERIOD",
  "EXPIRY_DATE_MISSING",
  "LEAVE_OVERLAP",
  "UNAUTHORISED_ENGAGEMENT",
] as const satisfies readonly BlockerCode[];

export const checkSchema = z
  .object({ workerId: uuid, siteId: uuid.optional(), from: calendarDate, to: calendarDate })
  .refine((p) => p.from <= p.to, { message: "Period must end on or after it starts", path: ["to"] });

export const overrideSchema = z.object({
  code: z.enum(BLOCKER_CODES),
  documentType: z.string().optional(),
  validUntil: calendarDate,
  reason: z.string().trim().min(5, "Give a reason of at least 5 characters").max(500),
});

@Injectable()
export class ComplianceService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(WorkersService) private readonly workers: WorkersService,
  ) {}

  async check(input: z.infer<typeof checkSchema>) {
    const [worker] = await this.db.orm.select().from(workers).where(eq(workers.id, input.workerId));
    if (!worker) throw new NotFoundException("Worker not found");
    let site: { id: string; requiredDocuments: DocumentType[] } | undefined;
    if (input.siteId) {
      const [row] = await this.db.orm.select().from(sites).where(eq(sites.id, input.siteId));
      if (!row) throw new NotFoundException("Site not found");
      site = { id: row.id, requiredDocuments: row.requiredDocuments as DocumentType[] };
    }
    const [docs, leave, overrides, engagements, policy] = await Promise.all([
      this.db.orm.select().from(workerDocuments).where(eq(workerDocuments.workerId, worker.id)),
      this.db.orm.select().from(leavePeriods).where(and(eq(leavePeriods.workerId, worker.id), eq(leavePeriods.status, "approved"))),
      this.db.orm.select().from(complianceOverrides).where(eq(complianceOverrides.workerId, worker.id)),
      this.db.orm.select().from(workerSponsorships).where(eq(workerSponsorships.workerId, worker.id)),
      readPolicy(this.db.orm),
    ]);
    return checkEligibility({
      worker: { id: worker.id, status: worker.status as WorkerStatus },
      documents: docs.map((d) => ({ type: d.type as DocumentType, expiryDate: d.expiryDate, verified: d.verified })),
      period: { from: input.from, to: input.to },
      today: this.clock.today(),
      site,
      leave: leave.map((l) => ({ from: l.fromDate, to: l.toDate })),
      engagements: engagements.map((e) => ({
        engagement: e.engagement as Engagement,
        from: e.validFrom,
        to: e.validTo,
        hasAuthorisation: e.authorisationRef !== null,
      })),
      unauthorisedPolicy: policy,
      overrides: overrides.map(
        (o): Override => ({
          code: o.code as BlockerCode,
          documentType: (o.documentType ?? undefined) as DocumentType | undefined,
          validUntil: o.validUntil,
          approvedBy: o.approvedBy,
          reason: o.reason,
        }),
      ),
    });
  }

  async addOverride(workerId: string, input: z.infer<typeof overrideSchema>, by: Principal) {
    const approvedBy = by.username;
    await this.workers.exists(workerId);
    if (input.validUntil < this.clock.today()) throw new BadRequestException("An override cannot end in the past");
    if (input.code === "UNAUTHORISED_ENGAGEMENT") {
      // A22: only the owner approves working with an unauthorised worker, and only while allowed.
      if (!by.permissions.has("overrides.approve_unauthorised")) {
        throw new HttpException({ code: "OWNER_APPROVAL_REQUIRED", message: "Only the owner can approve an unauthorised engagement." }, HttpStatus.FORBIDDEN);
      }
      if ((await readPolicy(this.db.orm)) === "block") {
        throw new HttpException({ code: "POLICY_BLOCKS", message: "The company setting blocks unauthorised engagements; no override is possible." }, HttpStatus.CONFLICT);
      }
    }
    return this.db.orm.transaction(async (tx) => {
      const [row] = await tx.insert(complianceOverrides).values({ workerId, ...input, approvedBy }).returning();
      await this.audit.record(tx, {
        actor: approvedBy,
        action: "compliance.override",
        subjectType: "worker",
        subjectId: workerId,
        before: null,
        after: row,
      });
      return row!;
    });
  }

  async renewals() {
    const rows = await this.db.orm
      .select({
        id: workerDocuments.id,
        workerId: workerDocuments.workerId,
        type: workerDocuments.type,
        expiryDate: workerDocuments.expiryDate,
        workerName: workers.fullName,
        workerCode: workers.code,
      })
      .from(workerDocuments)
      .innerJoin(workers, eq(workers.id, workerDocuments.workerId))
      .where(ne(workers.status, "exited"));
    const queue = buildRenewalQueue(
      rows.map((r) => ({ ...r, type: r.type as DocumentType })),
      this.clock.today(),
    );
    return { items: queue };
  }

  async summary() {
    const all = await this.workers.allWithCompliance();
    const today = this.clock.today();
    const byStatus: Record<string, number> = {};
    const byCompliance = { ok: 0, due: 0, incomplete: 0, expired: 0 };
    const byEngagement: Record<string, number> = { own: 0, supplied: 0, transferred: 0, free_visa: 0 };
    let unauthorised = 0;
    let expiringIn30Days = 0;
    for (const w of all) {
      if (w.status !== "exited" && w.engagement) {
        byEngagement[w.engagement.engagement] = (byEngagement[w.engagement.engagement] ?? 0) + 1;
        if (w.engagement.isUnauthorised) unauthorised += 1;
      }
      byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
      byCompliance[w.compliance.state] += 1;
      const next = w.compliance.nextExpiry;
      if (next && next.daysLeft >= 0 && daysBetween(today, next.expiryDate) <= 30) expiringIn30Days += 1;
    }
    return { today, headcount: all.length, byStatus, byCompliance, byEngagement, unauthorised, expiringIn30Days };
  }
}
