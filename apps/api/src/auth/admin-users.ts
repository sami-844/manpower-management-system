import { Body, Controller, Get, HttpException, HttpStatus, Inject, Injectable, Param, Post, Put, Req } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { CLOCK, type Clock } from "../common/clock";
import { parse, parseId } from "../common/validation";
import { DB, type Database } from "../db/client";
import { userRoles, userSessions, users } from "../db/schema";
import type { AuthedRequest } from "./auth.guard";
import { publicUser, type Principal } from "./auth.service";
import { generateTemporaryPassword, hashPassword } from "./passwords";
import { RequirePermission } from "./permissions";

/** Version 1 issues accounts for these six roles only (PRD section 3, A14). */
export const V1_ROLES = ["owner", "ops_manager", "hr_pro", "payroll", "finance", "admin"] as const;

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{2,49}$/, "3–50 characters: letters, digits, dot, dash or underscore");
const rolesSchema = z.array(z.enum(V1_ROLES)).min(1).max(V1_ROLES.length);

export const createUserSchema = z.object({
  username,
  displayName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(200).optional(),
  roles: rolesSchema,
});
export const setRolesSchema = z.object({ roles: rolesSchema });

const problem = (status: number, code: string, message: string) => new HttpException({ code, message }, status);

@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Users who belong to the admin's entity (hold or held a role there), with their roles there only. */
  async list(actor: Principal) {
    const inEntity = this.db.orm.selectDistinct({ id: userRoles.userId }).from(userRoles).where(eq(userRoles.entityId, actor.entityId!));
    const rows = await this.db.orm.select().from(users).where(inArray(users.id, inEntity)).orderBy(asc(users.username));
    const roles = await this.db.orm
      .select({ userId: userRoles.userId, role: userRoles.roleKey, entityId: userRoles.entityId })
      .from(userRoles)
      .where(and(isNull(userRoles.revokedAt), eq(userRoles.entityId, actor.entityId!)));
    const now = this.clock.now();
    return {
      items: rows.map((u) => ({
        ...publicUser(u),
        isLocked: u.lockedUntil !== null && u.lockedUntil.getTime() > now,
        lastSignInAt: u.lastSignInAt?.toISOString() ?? null,
        roles: roles.filter((r) => r.userId === u.id).map((r) => ({ role: r.role, entityId: r.entityId })),
      })),
    };
  }

  async create(actor: Principal, input: z.infer<typeof createUserSchema>) {
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const today = this.clock.today();
    return this.db.orm.transaction(async (tx) => {
      const [existing] = await tx.select({ id: users.id }).from(users).where(eq(sql`lower(${users.username})`, input.username));
      if (existing) throw problem(HttpStatus.CONFLICT, "USERNAME_TAKEN", "That username is already in use.");
      const [user] = await tx
        .insert(users)
        .values({
          username: input.username,
          displayName: input.displayName,
          email: input.email ?? null,
          passwordHash,
          isPasswordChangeRequired: true,
          createdBy: actor.username,
          updatedBy: actor.username,
        })
        .returning();
      await tx
        .insert(userRoles)
        .values(input.roles.map((role) => ({ userId: user!.id, roleKey: role, entityId: actor.entityId!, validFrom: today, createdBy: actor.username })));
      await this.audit.record(tx, {
        actor: actor.username,
        action: "user.create",
        subjectType: "user",
        subjectId: user!.id,
        before: null,
        after: { ...publicUser(user!), roles: input.roles, entityId: actor.entityId },
      });
      // Shown once, to the admin who creates the account; the user must replace it at first sign-in.
      return { user: publicUser(user!), temporaryPassword };
    });
  }

  async setRoles(actor: Principal, userId: string, roles: readonly string[]) {
    if (userId === actor.userId && !roles.includes("admin")) {
      throw problem(HttpStatus.BAD_REQUEST, "CANNOT_REMOVE_OWN_ADMIN", "You cannot remove your own admin role.");
    }
    const now = new Date(this.clock.now());
    const today = this.clock.today();
    return this.db.orm.transaction(async (tx) => {
      const user = await this.load(tx, actor, userId);
      const current = await tx
        .select()
        .from(userRoles)
        .where(and(eq(userRoles.userId, userId), eq(userRoles.entityId, actor.entityId!), isNull(userRoles.revokedAt)));
      const before = current.map((r) => r.roleKey).sort();
      const ending = current.filter((r) => !roles.includes(r.roleKey));
      const adding = roles.filter((r) => !current.some((c) => c.roleKey === r));
      if (ending.length) {
        await tx
          .update(userRoles)
          .set({ revokedAt: now, revokedBy: actor.username })
          .where(inArray(userRoles.id, ending.map((r) => r.id)));
      }
      if (adding.length) {
        await tx
          .insert(userRoles)
          .values(adding.map((role) => ({ userId, roleKey: role, entityId: actor.entityId!, validFrom: today, createdBy: actor.username })));
      }
      await this.audit.record(tx, {
        actor: actor.username,
        action: "user.roles",
        subjectType: "user",
        subjectId: user.id,
        before: { roles: before, entityId: actor.entityId },
        after: { roles: [...roles].sort(), entityId: actor.entityId },
      });
      return { roles: [...roles].sort() };
    });
  }

  async resetPassword(actor: Principal, userId: string) {
    if (userId === actor.userId) {
      throw problem(HttpStatus.BAD_REQUEST, "USE_CHANGE_PASSWORD", "Change your own password from your profile.");
    }
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    await this.change(actor, userId, "user.reset_password", "password_reset", {
      passwordHash,
      isPasswordChangeRequired: true,
      failedSignIns: 0,
      lockedUntil: null,
    });
    return { temporaryPassword };
  }

  resetTotp(actor: Principal, userId: string) {
    return this.change(actor, userId, "user.reset_two_factor", "two_factor_reset", {
      totpSecretSealed: null,
      totpPendingSealed: null,
      totpLastStep: null,
    });
  }

  unlock(actor: Principal, userId: string) {
    return this.change(actor, userId, "user.unlock", null, { failedSignIns: 0, lockedUntil: null });
  }

  disable(actor: Principal, userId: string) {
    if (userId === actor.userId) throw problem(HttpStatus.BAD_REQUEST, "CANNOT_DISABLE_SELF", "You cannot disable your own account.");
    return this.change(actor, userId, "user.disable", "account_disabled", { status: "disabled" });
  }

  enable(actor: Principal, userId: string) {
    return this.change(actor, userId, "user.enable", null, { status: "active", failedSignIns: 0, lockedUntil: null });
  }

  /** One audited change to a user; `endSessions` names why every open session ends with it. */
  private change(actor: Principal, userId: string, action: string, endSessions: string | null, set: Partial<typeof users.$inferInsert>) {
    const now = new Date(this.clock.now());
    return this.db.orm.transaction(async (tx) => {
      const before = await this.load(tx, actor, userId);
      const [after] = await tx
        .update(users)
        .set({ ...set, updatedAt: now, updatedBy: actor.username })
        .where(eq(users.id, userId))
        .returning();
      if (endSessions) {
        await tx
          .update(userSessions)
          .set({ revokedAt: now, revokeReason: endSessions })
          .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)));
      }
      await this.audit.record(tx, { actor: actor.username, action, subjectType: "user", subjectId: userId, before: publicUser(before), after: publicUser(after!) });
      return { user: publicUser(after!) };
    });
  }

  /**
   * The target user, locked for the change, only if an admin of this entity may manage them: they
   * belong to this entity and hold no active role in another (that needs an admin of both).
   * A user of another entity is reported as not found, so admins cannot probe other companies.
   */
  private async load(tx: Parameters<Parameters<Database["orm"]["transaction"]>[0]>[0], actor: Principal, userId: string) {
    const memberships = await tx
      .select({ entityId: userRoles.entityId, revokedAt: userRoles.revokedAt })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    const belongs = memberships.some((m) => m.entityId === actor.entityId);
    const elsewhere = memberships.some((m) => m.entityId !== actor.entityId && m.revokedAt === null);
    const [user] = belongs ? await tx.select().from(users).where(eq(users.id, userId)).for("update") : [];
    if (!user) throw problem(HttpStatus.NOT_FOUND, "USER_NOT_FOUND", "No such user.");
    if (elsewhere) throw problem(HttpStatus.FORBIDDEN, "USER_IN_OTHER_ENTITY", "This user also works for another company; an admin of both must change them.");
    return user;
  }
}

@Controller("api/admin/users")
export class AdminUsersController {
  constructor(@Inject(AdminUsersService) private readonly users: AdminUsersService) {}

  @RequirePermission("users.manage")
  @Get()
  list(@Req() req: AuthedRequest) {
    return this.users.list(req.auth!);
  }

  @RequirePermission("users.manage")
  @Post()
  create(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.users.create(req.auth!, parse(createUserSchema, body));
  }

  @RequirePermission("users.manage")
  @Put(":id/roles")
  setRoles(@Param("id") id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return this.users.setRoles(req.auth!, parseId(id), parse(setRolesSchema, body).roles);
  }

  @RequirePermission("users.manage")
  @Post(":id/reset-password")
  resetPassword(@Param("id") id: string, @Req() req: AuthedRequest) {
    return this.users.resetPassword(req.auth!, parseId(id));
  }

  @RequirePermission("users.manage")
  @Post(":id/reset-2fa")
  resetTotp(@Param("id") id: string, @Req() req: AuthedRequest) {
    return this.users.resetTotp(req.auth!, parseId(id));
  }

  @RequirePermission("users.manage")
  @Post(":id/unlock")
  unlock(@Param("id") id: string, @Req() req: AuthedRequest) {
    return this.users.unlock(req.auth!, parseId(id));
  }

  @RequirePermission("users.manage")
  @Post(":id/disable")
  disable(@Param("id") id: string, @Req() req: AuthedRequest) {
    return this.users.disable(req.auth!, parseId(id));
  }

  @RequirePermission("users.manage")
  @Post(":id/enable")
  enable(@Param("id") id: string, @Req() req: AuthedRequest) {
    return this.users.enable(req.auth!, parseId(id));
  }
}
