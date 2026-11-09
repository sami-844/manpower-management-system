import { Body, Controller, Get, HttpCode, HttpException, HttpStatus, Inject, Injectable, Module, Param, Patch, Post, Put, Req } from "@nestjs/common";
import { addDays, ENGAGEMENTS, omr, type Engagement, type UnauthorisedPolicy } from "@mms/core";
import { and, asc, desc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import type { AuthedRequest } from "../auth/auth.guard";
import { RequirePermission } from "../auth/permissions";
import { CLOCK, type Clock } from "../common/clock";
import { calendarDate, parse, parseId, uuid } from "../common/validation";
import { DB, type Database, type Orm } from "../db/client";
import { settings, sponsors, suppliers, supplyAgreements, supplyRateLines, workers, workerSponsorships } from "../db/schema";

/**
 * Sponsors and outsourced workers (PRD 4.18; A21 Version 1, A22 unauthorised engagements allowed
 * with the owner's approval behind one setting, A23 free-visa payees, A24 WPS proof before paying).
 */

type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];
const problem = (status: number, code: string, message: string) => new HttpException({ code, message }, status);

export const POLICY_KEY = "outsourcing.unauthorised";
const OWN_PLACEHOLDER = "Own company (record the legal name)";

/**
 * A supplied or transferred row without a verified authorisation, or any free-visa row (PRD 4.18,
 * A22). The reference alone is only a claim: it counts once someone other than its recorder has
 * checked it, so no single person can make an outsourced worker "authorised".
 */
export const hasVerifiedAuthorisation = (r: { authorisationRef: string | null; authorisationVerifiedBy: string | null }) =>
  r.authorisationRef !== null && r.authorisationVerifiedBy !== null;
export const isUnauthorised = (r: { engagement: string; authorisationRef: string | null; authorisationVerifiedBy: string | null }) =>
  r.engagement === "free_visa" || (r.engagement !== "own" && !hasVerifiedAuthorisation(r));

export async function readPolicy(orm: Orm | Tx): Promise<UnauthorisedPolicy> {
  const [row] = await orm.select({ value: settings.value }).from(settings).where(eq(settings.key, POLICY_KEY));
  return row?.value === "block" ? "block" : "allow_with_owner_approval";
}

async function ensureOwnSponsor(tx: Tx, actor: string) {
  const [own] = await tx.select().from(sponsors).where(eq(sponsors.kind, "own"));
  if (own) return own;
  const [created] = await tx.insert(sponsors).values({ kind: "own", legalName: OWN_PLACEHOLDER, createdBy: actor, updatedBy: actor }).returning();
  return created!;
}

// ---------------------------------------------------------------------------------------------
// Recording a worker's engagement (shared by worker creation and the engagement endpoint)
// ---------------------------------------------------------------------------------------------

export const engagementSchema = z.object({
  engagement: z.enum(ENGAGEMENTS),
  sponsorId: uuid.optional(),
  supplyAgreementId: uuid.optional(),
  authorisationRef: z.string().trim().min(3).max(100).optional(),
});
export const recordEngagementSchema = engagementSchema.extend({ validFrom: calendarDate });

export async function recordEngagement(
  tx: Tx,
  audit: AuditService,
  workerId: string,
  input: z.infer<typeof recordEngagementSchema>,
  actor: string,
) {
  // One engagement change per worker at a time.
  await tx.select({ id: workers.id }).from(workers).where(eq(workers.id, workerId)).for("update");

  let sponsorId: string | null = input.sponsorId ?? null;
  if (input.engagement === "own") {
    const own = await ensureOwnSponsor(tx, actor);
    if (sponsorId && sponsorId !== own.id) throw problem(HttpStatus.BAD_REQUEST, "NOT_OWN_SPONSOR", "An own worker is sponsored by the company itself.");
    if (input.supplyAgreementId || input.authorisationRef) {
      throw problem(HttpStatus.BAD_REQUEST, "OWN_HAS_NO_AGREEMENT", "An own worker has no supply agreement or outside authorisation.");
    }
    sponsorId = own.id;
  } else {
    if (input.engagement !== "free_visa" && !sponsorId) {
      throw problem(HttpStatus.BAD_REQUEST, "SPONSOR_REQUIRED", "Choose the company that sponsors this worker.");
    }
    if (input.engagement === "free_visa" && input.authorisationRef) {
      throw problem(HttpStatus.BAD_REQUEST, "FREE_VISA_HAS_NO_AUTHORISATION", "A free-visa worker has no authorisation; record them as supplied or transferred instead.");
    }
    if (sponsorId) {
      const [s] = await tx.select().from(sponsors).where(eq(sponsors.id, sponsorId));
      if (!s) throw problem(HttpStatus.NOT_FOUND, "SPONSOR_NOT_FOUND", "No such sponsor.");
      if (s.kind !== "external") throw problem(HttpStatus.BAD_REQUEST, "SPONSOR_IS_OWN", "An outsourced worker is sponsored by another company.");
      if (s.status !== "active") throw problem(HttpStatus.BAD_REQUEST, "SPONSOR_ARCHIVED", "That sponsor is archived.");
    }
    if (input.supplyAgreementId) {
      const [a] = await tx.select().from(supplyAgreements).where(eq(supplyAgreements.id, input.supplyAgreementId));
      if (!a) throw problem(HttpStatus.NOT_FOUND, "AGREEMENT_NOT_FOUND", "No such supply agreement.");
      if (a.status !== "approved") throw problem(HttpStatus.BAD_REQUEST, "AGREEMENT_NOT_APPROVED", "The supply agreement must be approved first.");
      if (input.validFrom < a.startDate || (a.endDate !== null && input.validFrom > a.endDate)) {
        throw problem(HttpStatus.BAD_REQUEST, "AGREEMENT_NOT_IN_FORCE", "The supply agreement does not cover that date.");
      }
      if (a.payee === "sponsor" && a.sponsorId !== sponsorId) {
        throw problem(HttpStatus.BAD_REQUEST, "AGREEMENT_OTHER_SPONSOR", "That agreement is with a different sponsor.");
      }
      if (a.payee === "worker" && a.workerId !== workerId) {
        throw problem(HttpStatus.BAD_REQUEST, "AGREEMENT_OTHER_WORKER", "That agreement pays a different worker.");
      }
    }
  }

  // Close the open record the day before; history is never rewritten.
  const later = await tx
    .select()
    .from(workerSponsorships)
    .where(and(eq(workerSponsorships.workerId, workerId), or(isNull(workerSponsorships.validTo), gte(workerSponsorships.validTo, input.validFrom))));
  if (later.some((r) => r.validFrom >= input.validFrom)) {
    throw problem(HttpStatus.CONFLICT, "ENGAGEMENT_CONFLICT", "A sponsorship already starts on or after that date.");
  }
  for (const r of later) {
    await tx.update(workerSponsorships).set({ validTo: addDays(input.validFrom, -1) }).where(eq(workerSponsorships.id, r.id));
  }
  const [row] = await tx
    .insert(workerSponsorships)
    .values({
      workerId,
      sponsorId,
      engagement: input.engagement,
      supplyAgreementId: input.supplyAgreementId ?? null,
      authorisationRef: input.authorisationRef ?? null,
      validFrom: input.validFrom,
      createdBy: actor,
    })
    .returning();
  await audit.record(tx, {
    actor,
    action: "worker.engagement",
    subjectType: "worker",
    subjectId: workerId,
    before: later.map((r) => ({ id: r.id, engagement: r.engagement, sponsorId: r.sponsorId, validFrom: r.validFrom, validTo: r.validTo })),
    after: row,
  });
  return { ...row!, isUnauthorised: isUnauthorised(row!) };
}

// ---------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------

const optionalText = (max: number) => z.string().trim().min(1).max(max).optional();

export const createSponsorSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  crNumber: optionalText(40),
  molEstablishmentNo: optionalText(40),
  vatNumber: optionalText(40),
  paymentTermsDays: z.number().int().min(0).max(365).default(30),
});
export const updateSponsorSchema = z
  .object({
    legalName: z.string().trim().min(2).max(200).optional(),
    crNumber: optionalText(40),
    molEstablishmentNo: optionalText(40),
    status: z.enum(["active", "archived"]).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });

const INCLUDED_BY = z.enum(["sponsor", "company"]);
export const createAgreementSchema = z
  .object({
    payee: z.enum(["sponsor", "middleman", "worker"]),
    sponsorId: uuid.optional(),
    middlemanName: z.string().trim().min(2).max(200).optional(),
    workerId: uuid.optional(),
    reference: z.string().trim().min(2).max(60),
    startDate: calendarDate,
    endDate: calendarDate.optional(),
    paymentTermsDays: z.number().int().min(0).max(365).default(30),
    minBillableDays: z.number().int().min(0).max(31).optional(),
    inclusions: z
      .object({ accommodation: INCLUDED_BY, transport: INCLUDED_BY, food: INCLUDED_BY, ppe: INCLUDED_BY })
      .partial()
      .default({}),
  })
  .refine((a) => !a.endDate || a.endDate >= a.startDate, { message: "The agreement must end on or after it starts", path: ["endDate"] })
  .refine((a) => (a.payee === "sponsor" ? !!a.sponsorId : a.payee === "middleman" ? !!a.middlemanName : !!a.workerId), {
    message: "Name who is paid: the sponsor, the middleman or the worker",
    path: ["payee"],
  });

export const addRateSchema = z
  .object({
    trade: z.string().trim().min(2).max(60),
    hourType: z.enum(["normal", "overtime", "rest_day", "holiday", "night"]),
    unit: z.enum(["hour", "day", "month"]),
    // Money as a decimal string, never a float (CLAUDE.md rule 2): up to 3 decimals (baisa).
    rate: z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, "An amount in OMR such as 1.250"),
    validFrom: calendarDate,
    validTo: calendarDate.optional(),
  })
  .refine((r) => !r.validTo || r.validTo >= r.validFrom, { message: "Must end on or after it starts", path: ["validTo"] });

export const policySchema = z.object({ unauthorised: z.enum(["allow_with_owner_approval", "block"]) });

@Injectable()
export class SponsorsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Every sponsor with how many workers it holds today, by engagement (one screen: PRD 4.18). */
  async list() {
    const today = this.clock.today();
    const [rows, counts] = await Promise.all([
      this.db.orm.select().from(sponsors).orderBy(desc(sql`${sponsors.kind} = 'own'`), asc(sponsors.legalName)),
      this.db.orm
        .select({
          sponsorId: workerSponsorships.sponsorId,
          engagement: workerSponsorships.engagement,
          unauthorised: sql<boolean>`${workerSponsorships.engagement} = 'free_visa' or (${workerSponsorships.engagement} <> 'own' and (${workerSponsorships.authorisationRef} is null or ${workerSponsorships.authorisationVerifiedBy} is null))`,
          n: sql<number>`count(*)::int`,
        })
        .from(workerSponsorships)
        .innerJoin(workers, eq(workers.id, workerSponsorships.workerId))
        .where(
          and(
            lte(workerSponsorships.validFrom, today),
            or(isNull(workerSponsorships.validTo), gte(workerSponsorships.validTo, today)),
            sql`${workers.status} <> 'exited'`,
          ),
        )
        .groupBy(workerSponsorships.sponsorId, workerSponsorships.engagement, sql`3`),
    ]);
    const tally = (sponsorId: string | null) => {
      const mine = counts.filter((c) => c.sponsorId === sponsorId);
      const byEngagement = Object.fromEntries(ENGAGEMENTS.map((e) => [e, 0])) as Record<Engagement, number>;
      for (const c of mine) byEngagement[c.engagement as Engagement] += c.n;
      return {
        total: mine.reduce((sum, c) => sum + c.n, 0),
        byEngagement,
        unauthorised: mine.filter((c) => c.unauthorised).reduce((sum, c) => sum + c.n, 0),
      };
    };
    return {
      today,
      items: rows.map((s) => ({
        id: s.id,
        kind: s.kind,
        legalName: s.legalName,
        crNumber: s.crNumber,
        molEstablishmentNo: s.molEstablishmentNo,
        status: s.status,
        workers: tally(s.id),
      })),
      // Free-visa workers whose sponsor is not known.
      unknownSponsor: tally(null),
    };
  }

  async createSponsor(input: z.infer<typeof createSponsorSchema>, actor: string) {
    return this.db.orm.transaction(async (tx) => {
      if (input.crNumber) {
        const [dup] = await tx.select({ id: sponsors.id }).from(sponsors).where(sql`lower(${sponsors.crNumber}) = lower(${input.crNumber})`);
        if (dup) throw problem(HttpStatus.CONFLICT, "SPONSOR_EXISTS", "A sponsor with that CR number is already recorded.");
      }
      // The company pays an outside sponsor for its supplied workers, so it is also a ledger supplier.
      const [supplier] = await tx
        .insert(suppliers)
        .values({ name: input.legalName, vatNumber: input.vatNumber ?? null, paymentTermsDays: input.paymentTermsDays, createdBy: actor, updatedBy: actor })
        .returning();
      const [sponsor] = await tx
        .insert(sponsors)
        .values({
          kind: "external",
          legalName: input.legalName,
          crNumber: input.crNumber ?? null,
          molEstablishmentNo: input.molEstablishmentNo ?? null,
          supplierId: supplier!.id,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning();
      await this.audit.record(tx, { actor, action: "sponsor.create", subjectType: "sponsor", subjectId: sponsor!.id, before: null, after: sponsor });
      return sponsor!;
    });
  }

  async updateSponsor(id: string, input: z.infer<typeof updateSponsorSchema>, actor: string) {
    return this.db.orm.transaction(async (tx) => {
      const [before] = await tx.select().from(sponsors).where(eq(sponsors.id, id)).for("update");
      if (!before) throw problem(HttpStatus.NOT_FOUND, "SPONSOR_NOT_FOUND", "No such sponsor.");
      if (before.kind === "own" && input.status === "archived") {
        throw problem(HttpStatus.BAD_REQUEST, "OWN_SPONSOR_STAYS", "The company's own sponsor record cannot be archived.");
      }
      const [after] = await tx
        .update(sponsors)
        .set({ ...input, updatedAt: new Date(this.clock.now()), updatedBy: actor })
        .where(eq(sponsors.id, id))
        .returning();
      await this.audit.record(tx, { actor, action: "sponsor.update", subjectType: "sponsor", subjectId: id, before, after });
      return after!;
    });
  }

  async engagements(workerId: string) {
    const rows = await this.db.orm
      .select({ s: workerSponsorships, sponsorName: sponsors.legalName })
      .from(workerSponsorships)
      .leftJoin(sponsors, eq(sponsors.id, workerSponsorships.sponsorId))
      .where(eq(workerSponsorships.workerId, workerId))
      .orderBy(desc(workerSponsorships.validFrom));
    return { items: rows.map((r) => ({ ...r.s, sponsorName: r.sponsorName, isUnauthorised: isUnauthorised(r.s) })) };
  }

  /** The second person checks the authorisation reference against the Ministry record (four eyes). */
  async verifyAuthorisation(workerId: string, sponsorshipId: string, actor: string) {
    return this.db.orm.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(workerSponsorships)
        .where(and(eq(workerSponsorships.id, sponsorshipId), eq(workerSponsorships.workerId, workerId)))
        .for("update");
      if (!before) throw problem(HttpStatus.NOT_FOUND, "SPONSORSHIP_NOT_FOUND", "No such sponsorship record.");
      if (!before.authorisationRef) throw problem(HttpStatus.BAD_REQUEST, "NO_AUTHORISATION", "There is no authorisation reference to verify.");
      if (before.authorisationVerifiedBy) throw problem(HttpStatus.CONFLICT, "ALREADY_VERIFIED", "This authorisation is already verified.");
      if (before.createdBy === actor) throw problem(HttpStatus.FORBIDDEN, "FOUR_EYES", "Someone other than the person who recorded it must verify it.");
      const [after] = await tx
        .update(workerSponsorships)
        .set({ authorisationVerifiedBy: actor, authorisationVerifiedAt: new Date(this.clock.now()) })
        .where(eq(workerSponsorships.id, sponsorshipId))
        .returning();
      await this.audit.record(tx, { actor, action: "worker.authorisation_verify", subjectType: "worker", subjectId: workerId, before, after });
      return { ...after!, isUnauthorised: isUnauthorised(after!) };
    });
  }

  async recordEngagement(workerId: string, input: z.infer<typeof recordEngagementSchema>, actor: string) {
    const [worker] = await this.db.orm.select({ id: workers.id }).from(workers).where(eq(workers.id, workerId));
    if (!worker) throw problem(HttpStatus.NOT_FOUND, "WORKER_NOT_FOUND", "Worker not found");
    return this.db.orm.transaction((tx) => recordEngagement(tx, this.audit, workerId, input, actor));
  }

  async agreements() {
    const rows = await this.db.orm
      .select({ a: supplyAgreements, sponsorName: sponsors.legalName, payeeName: suppliers.name, workerName: workers.fullName })
      .from(supplyAgreements)
      .leftJoin(sponsors, eq(sponsors.id, supplyAgreements.sponsorId))
      .leftJoin(suppliers, eq(suppliers.id, supplyAgreements.supplierId))
      .leftJoin(workers, eq(workers.id, supplyAgreements.workerId))
      .orderBy(desc(supplyAgreements.startDate));
    return { items: rows.map((r) => ({ ...r.a, sponsorName: r.sponsorName, payeeName: r.payeeName ?? r.workerName })) };
  }

  async agreement(id: string) {
    const [a] = await this.db.orm.select().from(supplyAgreements).where(eq(supplyAgreements.id, id));
    if (!a) throw problem(HttpStatus.NOT_FOUND, "AGREEMENT_NOT_FOUND", "No such supply agreement.");
    const rates = await this.db.orm
      .select()
      .from(supplyRateLines)
      .where(eq(supplyRateLines.supplyAgreementId, id))
      .orderBy(asc(supplyRateLines.trade), asc(supplyRateLines.hourType), asc(supplyRateLines.validFrom));
    return { ...a, rates };
  }

  async createAgreement(input: z.infer<typeof createAgreementSchema>, actor: string) {
    return this.db.orm.transaction(async (tx) => {
      let sponsorId: string | null = null;
      let supplierId: string | null = null;
      let workerId: string | null = null;
      if (input.payee === "sponsor") {
        const [s] = await tx.select().from(sponsors).where(eq(sponsors.id, input.sponsorId!));
        if (!s || s.kind !== "external") throw problem(HttpStatus.BAD_REQUEST, "SPONSOR_NOT_FOUND", "Choose an outside sponsor.");
        sponsorId = s.id;
        supplierId = s.supplierId;
      } else if (input.payee === "middleman") {
        const [m] = await tx.insert(suppliers).values({ name: input.middlemanName!, paymentTermsDays: input.paymentTermsDays, createdBy: actor, updatedBy: actor }).returning();
        supplierId = m!.id;
      } else {
        const [w] = await tx.select({ id: workers.id }).from(workers).where(eq(workers.id, input.workerId!));
        if (!w) throw problem(HttpStatus.NOT_FOUND, "WORKER_NOT_FOUND", "Worker not found");
        workerId = w.id;
      }
      const [row] = await tx
        .insert(supplyAgreements)
        .values({
          payee: input.payee,
          sponsorId,
          supplierId,
          workerId,
          reference: input.reference,
          startDate: input.startDate,
          endDate: input.endDate ?? null,
          paymentTermsDays: input.paymentTermsDays,
          minBillableDays: input.minBillableDays ?? null,
          inclusions: input.inclusions,
          createdBy: actor,
          updatedBy: actor,
        })
        .returning();
      await this.audit.record(tx, { actor, action: "supply_agreement.create", subjectType: "supply_agreement", subjectId: row!.id, before: null, after: row });
      return row!;
    });
  }

  /** Rates are added while the agreement is a draft; an approved agreement is locked (four eyes). */
  async addRate(id: string, input: z.infer<typeof addRateSchema>, actor: string) {
    const rate = omr(input.rate).toFixed(3);
    return this.db.orm.transaction(async (tx) => {
      const [a] = await tx.select().from(supplyAgreements).where(eq(supplyAgreements.id, id)).for("update");
      if (!a) throw problem(HttpStatus.NOT_FOUND, "AGREEMENT_NOT_FOUND", "No such supply agreement.");
      if (a.status !== "draft") throw problem(HttpStatus.CONFLICT, "AGREEMENT_LOCKED", "An approved agreement cannot change; record a new one.");
      const overlap = await tx
        .select({ id: supplyRateLines.id })
        .from(supplyRateLines)
        .where(
          and(
            eq(supplyRateLines.supplyAgreementId, id),
            eq(supplyRateLines.trade, input.trade),
            eq(supplyRateLines.hourType, input.hourType),
            sql`daterange(${supplyRateLines.validFrom}, ${supplyRateLines.validTo}, '[]') && daterange(${input.validFrom}::date, ${input.validTo ?? null}::date, '[]')`,
          ),
        );
      if (overlap.length) throw problem(HttpStatus.CONFLICT, "RATE_OVERLAPS", "A rate for that trade and hour type already covers those dates.");
      const [row] = await tx
        .insert(supplyRateLines)
        .values({ supplyAgreementId: id, trade: input.trade, hourType: input.hourType, unit: input.unit, rate, validFrom: input.validFrom, validTo: input.validTo ?? null, createdBy: actor })
        .returning();
      await this.audit.record(tx, { actor, action: "supply_agreement.rate", subjectType: "supply_agreement", subjectId: id, before: null, after: row });
      return row!;
    });
  }

  async approve(id: string, actor: string) {
    return this.db.orm.transaction(async (tx) => {
      const [a] = await tx.select().from(supplyAgreements).where(eq(supplyAgreements.id, id)).for("update");
      if (!a) throw problem(HttpStatus.NOT_FOUND, "AGREEMENT_NOT_FOUND", "No such supply agreement.");
      if (a.status !== "draft") throw problem(HttpStatus.CONFLICT, "ALREADY_APPROVED", "This agreement is already approved.");
      const rates = await tx.select({ createdBy: supplyRateLines.createdBy }).from(supplyRateLines).where(eq(supplyRateLines.supplyAgreementId, id));
      // Nobody approves terms they wrote: neither the agreement nor any of its rates.
      if (a.createdBy === actor || rates.some((r) => r.createdBy === actor)) {
        throw problem(HttpStatus.FORBIDDEN, "FOUR_EYES", "Someone who recorded neither the agreement nor its rates must approve it.");
      }
      if (rates.length === 0) throw problem(HttpStatus.BAD_REQUEST, "NO_RATES", "Add at least one rate before approving.");
      const now = new Date(this.clock.now());
      const [after] = await tx
        .update(supplyAgreements)
        .set({ status: "approved", approvedBy: actor, approvedAt: now, updatedAt: now, updatedBy: actor })
        .where(eq(supplyAgreements.id, id))
        .returning();
      await this.audit.record(tx, { actor, action: "supply_agreement.approve", subjectType: "supply_agreement", subjectId: id, before: a, after });
      return after!;
    });
  }

  async policy() {
    return { unauthorised: await readPolicy(this.db.orm) };
  }

  async setPolicy(input: z.infer<typeof policySchema>, actor: string) {
    return this.db.orm.transaction(async (tx) => {
      const before = await readPolicy(tx);
      await tx
        .insert(settings)
        .values({ key: POLICY_KEY, value: input.unauthorised, updatedBy: actor })
        .onConflictDoUpdate({ target: [settings.entityId, settings.key], set: { value: input.unauthorised, updatedAt: new Date(this.clock.now()), updatedBy: actor } });
      await this.audit.record(tx, {
        actor,
        action: "settings.outsourcing",
        subjectType: "setting",
        subjectId: POLICY_KEY,
        before: { unauthorised: before },
        after: { unauthorised: input.unauthorised },
      });
      return { unauthorised: input.unauthorised };
    });
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

@Controller("api")
export class SponsorsController {
  constructor(@Inject(SponsorsService) private readonly sponsors: SponsorsService) {}

  @RequirePermission("sponsors.read")
  @Get("sponsors")
  list() {
    return this.sponsors.list();
  }

  @RequirePermission("sponsors.manage")
  @Post("sponsors")
  create(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.sponsors.createSponsor(parse(createSponsorSchema, body), req.auth!.username);
  }

  @RequirePermission("sponsors.manage")
  @Patch("sponsors/:id")
  update(@Param("id") id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.sponsors.updateSponsor(parseId(id), parse(updateSponsorSchema, body), req.auth!.username);
  }

  @RequirePermission("workers.read")
  @Get("workers/:id/sponsorships")
  engagements(@Param("id") id: string) {
    return this.sponsors.engagements(parseId(id));
  }

  @RequirePermission("sponsors.manage")
  @Post("workers/:id/sponsorships")
  recordEngagement(@Param("id") id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.sponsors.recordEngagement(parseId(id), parse(recordEngagementSchema, body), req.auth!.username);
  }

  @RequirePermission("documents.verify")
  @Post("workers/:id/sponsorships/:sid/verify-authorisation")
  @HttpCode(200)
  verifyAuthorisation(@Param("id") id: string, @Param("sid") sid: string, @Req() req: AuthedRequest) {
    return this.sponsors.verifyAuthorisation(parseId(id), parseId(sid), req.auth!.username);
  }

  @RequirePermission("sponsors.read")
  @Get("supply-agreements")
  agreements() {
    return this.sponsors.agreements();
  }

  @RequirePermission("sponsors.read")
  @Get("supply-agreements/:id")
  agreement(@Param("id") id: string) {
    return this.sponsors.agreement(parseId(id));
  }

  @RequirePermission("supply.manage")
  @Post("supply-agreements")
  createAgreement(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.sponsors.createAgreement(parse(createAgreementSchema, body), req.auth!.username);
  }

  @RequirePermission("supply.manage")
  @Post("supply-agreements/:id/rates")
  addRate(@Param("id") id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.sponsors.addRate(parseId(id), parse(addRateSchema, body), req.auth!.username);
  }

  @RequirePermission("supply.approve")
  @Post("supply-agreements/:id/approve")
  @HttpCode(200)
  approve(@Param("id") id: string, @Req() req: AuthedRequest) {
    return this.sponsors.approve(parseId(id), req.auth!.username);
  }

  @RequirePermission("sponsors.read")
  @Get("settings/outsourcing")
  policy() {
    return this.sponsors.policy();
  }

  @RequirePermission("outsourcing.policy")
  @Put("settings/outsourcing")
  setPolicy(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.sponsors.setPolicy(parse(policySchema, body), req.auth!.username);
  }
}

@Module({ controllers: [SponsorsController], providers: [SponsorsService], exports: [SponsorsService] })
export class SponsorsModule {}
