import { HttpException, HttpStatus, Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, gt, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { AuditService } from "../audit/audit.service";
import { CLOCK, type Clock } from "../common/clock";
import { DB, type Database, type Orm } from "../db/client";
import { loginAttempts, passwordHistory, rolePermissions, userRoles, userSessions, users } from "../db/schema";
import { AUTH_CONFIG, type AuthConfig } from "./config";
import {
  newRefreshToken,
  newTotpSecret,
  otpauthUrl,
  parseRefreshToken,
  safeEqual,
  seal,
  sha256Hex,
  signAccessToken,
  unseal,
  verifyAccessToken,
  verifyTotp,
} from "./crypto";
import { burnPasswordCheck, checkPasswordPolicy, hashPassword, HISTORY_DEPTH, verifyPassword } from "./passwords";
import type { PermissionKey, RoleKey } from "./permissions";

export const signInSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(256),
  otp: z.string().trim().max(10).optional(),
});
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});
/** Turning two-factor on or off: the password and a code, so a session alone can do neither (A31). */
export const totpChangeSchema = z.object({
  password: z.string().min(1).max(256),
  code: z.string().trim().min(1).max(10),
});

/** Who is acting, resolved from the access token on every request. */
export interface Principal {
  userId: string;
  username: string;
  displayName: string;
  sessionId: string;
  /** The legal entity this request acts in; null when the user holds roles in several and chose none. */
  entityId: string | null;
  entityChoices: string[];
  roles: RoleKey[];
  permissions: Set<PermissionKey>;
  isPasswordChangeRequired: boolean;
  hasTotp: boolean;
}

/** What a user owes before the app opens: only a temporary password; two-factor is optional (A31). */
export type NextStep = "change_password" | null;

export interface SignedInUser {
  id: string;
  username: string;
  displayName: string;
}

export interface Session {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  user: SignedInUser;
  next: NextStep;
}

export interface ClientInfo {
  ip: string | null;
  userAgent: string | null;
}

type Tx = Parameters<Parameters<Orm["transaction"]>[0]>[0];
type UserRow = typeof users.$inferSelect;

const problem = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  new HttpException({ code, message, ...extra }, status);
const invalidCredentials = () => problem(HttpStatus.UNAUTHORIZED, "INVALID_CREDENTIALS", "Wrong username or password.");
const sessionEnded = () => problem(HttpStatus.UNAUTHORIZED, "SESSION_ENDED", "Your session has ended. Sign in again.");

/** What audit entries may say about a user: never a hash, secret or token. */
export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    status: u.status,
    isPasswordChangeRequired: u.isPasswordChangeRequired,
    hasTotp: u.totpSecretSealed !== null,
    lockedUntil: u.lockedUntil?.toISOString() ?? null,
  };
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // Sign-in bookkeeping uses the base connection, outside any request transaction, so a refused
  // sign-in still leaves its attempt row and failure count behind.
  private get base(): Orm {
    return this.db.base;
  }

  private now(): Date {
    return new Date(this.clock.now());
  }

  nextStep(u: Pick<UserRow, "isPasswordChangeRequired">): NextStep {
    return u.isPasswordChangeRequired ? "change_password" : null;
  }

  // ------------------------------------------------------------------------------------------
  // Sign in
  // ------------------------------------------------------------------------------------------

  async signIn(input: z.infer<typeof signInSchema>, client: ClientInfo): Promise<Session> {
    const username = input.username.toLowerCase();
    const now = this.now();

    // The attempt row is written first and counted with the others, so parallel guesses from one
    // network see each other: the per-IP limit holds under concurrency, not just in sequence.
    const attemptId = await this.openAttempt(username, client);
    if (client.ip) {
      const since = new Date(now.getTime() - this.config.ipWindowSec * 1000);
      const [row] = await this.base
        .select({ n: count() })
        .from(loginAttempts)
        .where(and(eq(loginAttempts.ip, client.ip), eq(loginAttempts.isSuccess, false), gt(loginAttempts.at, since)));
      if ((row?.n ?? 0) > this.config.ipFailureLimit) {
        await this.closeAttempt(attemptId, null, false, "ip_limited");
        throw problem(HttpStatus.TOO_MANY_REQUESTS, "TOO_MANY_ATTEMPTS", "Too many failed sign-ins from this network. Try again later.");
      }
    }

    const [user] = await this.base.select().from(users).where(eq(sql`lower(${users.username})`, username)).limit(1);
    if (!user) {
      await burnPasswordCheck(input.password);
      await this.closeAttempt(attemptId, null, false, "unknown_user");
      throw invalidCredentials();
    }
    // Reserve one of the account's allowed failures before checking anything (see reserveTry).
    if (!(await this.reserveTry(user.id))) {
      await this.closeAttempt(attemptId, user.id, false, "locked");
      throw await this.lockedProblem(user.id);
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      await this.failTry(user, client, attemptId, "bad_password");
      throw invalidCredentials();
    }
    if (user.status !== "active") {
      await this.releaseTry(user.id);
      await this.closeAttempt(attemptId, user.id, false, "disabled");
      throw problem(HttpStatus.FORBIDDEN, "ACCOUNT_DISABLED", "This account is disabled. Ask the system admin.");
    }
    if (user.totpSecretSealed) {
      // The password was right; asking for the code is not a failure.
      if (!input.otp) {
        await this.releaseTry(user.id);
        await this.closeAttempt(attemptId, user.id, true, "otp_required");
        throw problem(HttpStatus.UNAUTHORIZED, "OTP_REQUIRED", "Enter the 6-digit code from your authenticator app.");
      }
      const secret = this.openSecret(user.totpSecretSealed);
      const step = verifyTotp(secret, input.otp, now.getTime(), user.totpLastStep);
      if (step === null || !(await this.claimTotpStep(this.base, user.id, step))) {
        await this.failTry(user, client, attemptId, "bad_otp");
        throw problem(HttpStatus.UNAUTHORIZED, "OTP_INVALID", "That code is wrong or has already been used.");
      }
    }

    return this.base.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ failedSignIns: 0, lockedUntil: null, lastSignInAt: now, updatedAt: now })
        .where(eq(users.id, user.id));
      const { sessionId, refreshToken } = await this.createSession(tx, user.id, client);
      await tx.update(loginAttempts).set({ userId: user.id, isSuccess: true, reason: "ok" }).where(eq(loginAttempts.id, attemptId));
      await this.audit.record(tx, {
        actor: user.username,
        action: "auth.sign_in",
        subjectType: "user",
        subjectId: user.id,
        before: null,
        after: { sessionId, ip: client.ip },
        entityId: await this.homeEntity(user.id),
      });
      return this.session(user, sessionId, refreshToken);
    });
  }

  // ------------------------------------------------------------------------------------------
  // Refresh: rotate on every use; the previous token works for a short grace (racing tabs);
  // anything older is a stolen-token signal and ends the session.
  // ------------------------------------------------------------------------------------------

  async refresh(refreshToken: string, client: ClientInfo): Promise<Session> {
    const parsed = parseRefreshToken(refreshToken);
    if (!parsed) throw sessionEnded();
    const nowMs = this.clock.now();
    const now = new Date(nowMs);

    const outcome = await this.base.transaction(async (tx) => {
      const [s] = await tx.select().from(userSessions).where(eq(userSessions.id, parsed.sessionId)).for("update");
      if (!s || s.revokedAt || !this.isLive(s, nowMs)) return { ended: true as const };
      const [user] = await tx.select().from(users).where(eq(users.id, s.userId));
      if (!user || user.status !== "active") return { ended: true as const };

      const hash = sha256Hex(refreshToken);
      const isCurrent = safeEqual(hash, s.refreshHash);
      const isGrace =
        s.previousRefreshHash !== null &&
        safeEqual(hash, s.previousRefreshHash) &&
        s.previousValidUntil !== null &&
        s.previousValidUntil.getTime() > nowMs;
      if (!isCurrent && !isGrace) {
        await this.revoke(tx, s.id, "refresh_token_reused", now);
        await this.audit.record(tx, {
          actor: user.username,
          action: "auth.refresh_reuse",
          subjectType: "user",
          subjectId: user.id,
          before: null,
          after: { sessionId: s.id, ip: client.ip },
          entityId: await this.homeEntity(user.id),
        });
        return { ended: true as const };
      }

      const next = newRefreshToken(s.id);
      await tx
        .update(userSessions)
        .set({
          refreshHash: sha256Hex(next),
          previousRefreshHash: s.refreshHash,
          previousValidUntil: new Date(nowMs + this.config.refreshGraceSec * 1000),
          lastSeenAt: now,
        })
        .where(eq(userSessions.id, s.id));
      return { ended: false as const, session: this.session(user, s.id, next) };
    });
    if (outcome.ended) throw sessionEnded();
    return outcome.session;
  }

  // ------------------------------------------------------------------------------------------
  // Every request: token → live session → active user → roles and permissions for one entity.
  // ------------------------------------------------------------------------------------------

  async authenticate(accessToken: string, requestedEntity: string | undefined): Promise<Principal> {
    const nowMs = this.clock.now();
    const claims = verifyAccessToken(accessToken, this.config.accessKey, Math.floor(nowMs / 1000));
    if (!claims) throw problem(HttpStatus.UNAUTHORIZED, "TOKEN_INVALID", "Sign in again.");

    const [row] = await this.base
      .select({ s: userSessions, u: users })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .where(and(eq(userSessions.id, claims.sid), eq(userSessions.userId, claims.sub)))
      .limit(1);
    if (!row || row.s.revokedAt || !this.isLive(row.s, nowMs) || row.u.status !== "active") throw sessionEnded();

    // Activity keeps the session alive (server-side idle limit); written at most once a minute.
    if (nowMs - row.s.lastSeenAt.getTime() > 60_000) {
      await this.base.update(userSessions).set({ lastSeenAt: new Date(nowMs) }).where(eq(userSessions.id, row.s.id));
    }

    const today = this.clock.today();
    const grants = await this.base
      .select({ role: userRoles.roleKey, entityId: userRoles.entityId, permission: rolePermissions.permissionKey })
      .from(userRoles)
      .leftJoin(rolePermissions, eq(rolePermissions.roleKey, userRoles.roleKey))
      .where(
        and(
          eq(userRoles.userId, row.u.id),
          isNull(userRoles.revokedAt),
          lte(userRoles.validFrom, today),
          or(isNull(userRoles.validTo), gte(userRoles.validTo, today)),
        ),
      );
    const entityChoices = [...new Set(grants.map((g) => g.entityId))].sort();
    let entityId: string | null = entityChoices.length === 1 ? entityChoices[0]! : null;
    if (requestedEntity) {
      if (!entityChoices.includes(requestedEntity)) {
        throw problem(HttpStatus.FORBIDDEN, "ENTITY_NOT_ALLOWED", "You hold no role in that company.");
      }
      entityId = requestedEntity;
    }
    const scoped = grants.filter((g) => g.entityId === entityId);
    return {
      userId: row.u.id,
      username: row.u.username,
      displayName: row.u.displayName,
      sessionId: row.s.id,
      entityId,
      entityChoices,
      roles: [...new Set(scoped.map((g) => g.role as RoleKey))],
      permissions: new Set(scoped.flatMap((g) => (g.permission ? [g.permission as PermissionKey] : []))),
      isPasswordChangeRequired: row.u.isPasswordChangeRequired,
      hasTotp: row.u.totpSecretSealed !== null,
    };
  }

  me(p: Principal) {
    return {
      user: { id: p.userId, username: p.username, displayName: p.displayName },
      entityId: p.entityId,
      entityChoices: p.entityChoices,
      roles: p.roles,
      permissions: [...p.permissions].sort(),
      next: this.nextStep(p),
      twoFactor: p.hasTotp,
    };
  }

  // ------------------------------------------------------------------------------------------
  // Sign out: by the access token's session, or by the refresh cookie if the access token is gone.
  // ------------------------------------------------------------------------------------------

  async signOut(accessToken: string | undefined, refreshToken: string | undefined): Promise<void> {
    const nowMs = this.clock.now();
    let sessionId: string | null = null;
    if (accessToken) sessionId = verifyAccessToken(accessToken, this.config.accessKey, Math.floor(nowMs / 1000))?.sid ?? null;
    if (!sessionId && refreshToken) {
      const parsed = parseRefreshToken(refreshToken);
      if (parsed) {
        const [s] = await this.base.select().from(userSessions).where(eq(userSessions.id, parsed.sessionId));
        const hash = sha256Hex(refreshToken);
        if (s && (safeEqual(hash, s.refreshHash) || (s.previousRefreshHash !== null && safeEqual(hash, s.previousRefreshHash)))) {
          sessionId = s.id;
        }
      }
    }
    if (!sessionId) return;
    const id = sessionId;
    await this.base.transaction(async (tx) => {
      const [s] = await tx.select().from(userSessions).where(eq(userSessions.id, id));
      if (!s || s.revokedAt) return;
      const [user] = await tx.select().from(users).where(eq(users.id, s.userId));
      await this.revoke(tx, s.id, "signed_out", new Date(nowMs));
      await this.audit.record(tx, {
        actor: user!.username,
        action: "auth.sign_out",
        subjectType: "user",
        subjectId: s.userId,
        before: null,
        after: { sessionId: s.id },
        entityId: await this.homeEntity(s.userId),
      });
    });
  }

  // ------------------------------------------------------------------------------------------
  // Password change: the current password is checked like a sign-in (it counts toward lockout);
  // the last five passwords cannot come back; every other session ends.
  // ------------------------------------------------------------------------------------------

  async changePassword(p: Principal, input: z.infer<typeof changePasswordSchema>, client: ClientInfo): Promise<{ next: NextStep }> {
    const [user] = await this.base.select().from(users).where(eq(users.id, p.userId));
    if (!user) throw sessionEnded();
    // Guessing the current password from a stolen session is a sign-in attempt like any other.
    if (!(await this.reserveTry(user.id))) throw await this.lockedProblem(user.id);
    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      await this.failTry(user, client, await this.openAttempt(user.username, client), "bad_current_password");
      throw problem(HttpStatus.BAD_REQUEST, "CURRENT_PASSWORD_WRONG", "Your current password is not right.");
    }
    await this.releaseTry(user.id);
    const problems = checkPasswordPolicy(input.newPassword, user.username);
    if (problems.length) throw problem(HttpStatus.BAD_REQUEST, "PASSWORD_POLICY", "Choose a different password.", { problems });
    const history = await this.base
      .select({ hash: passwordHistory.passwordHash })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, user.id))
      .orderBy(desc(passwordHistory.createdAt))
      .limit(HISTORY_DEPTH - 1);
    for (const old of [user.passwordHash, ...history.map((h) => h.hash)]) {
      if (await verifyPassword(input.newPassword, old)) {
        throw problem(HttpStatus.BAD_REQUEST, "PASSWORD_REUSED", `Choose a password you have not used in your last ${HISTORY_DEPTH}.`);
      }
    }
    const hash = await hashPassword(input.newPassword);
    const now = this.now();
    return this.base.transaction(async (tx) => {
      await tx.insert(passwordHistory).values({ userId: user.id, passwordHash: user.passwordHash, createdAt: now });
      const [after] = await tx
        .update(users)
        .set({ passwordHash: hash, isPasswordChangeRequired: false, passwordChangedAt: now, updatedAt: now, updatedBy: user.username })
        .where(eq(users.id, user.id))
        .returning();
      await tx
        .update(userSessions)
        .set({ revokedAt: now, revokeReason: "password_changed" })
        .where(and(eq(userSessions.userId, user.id), ne(userSessions.id, p.sessionId), isNull(userSessions.revokedAt)));
      await this.audit.record(tx, {
        actor: user.username,
        action: "auth.password_change",
        subjectType: "user",
        subjectId: user.id,
        before: publicUser(user),
        after: publicUser(after!),
        entityId: await this.homeEntity(user.id),
      });
      return { next: this.nextStep(after!) };
    });
  }

  // ------------------------------------------------------------------------------------------
  // Authenticator set-up: a pending secret until a first code proves the app has it.
  // ------------------------------------------------------------------------------------------

  async startTotpSetup(p: Principal): Promise<{ secret: string; otpauthUrl: string }> {
    if (p.isPasswordChangeRequired) {
      throw problem(HttpStatus.FORBIDDEN, "PASSWORD_CHANGE_REQUIRED", "Change your temporary password first.");
    }
    if (p.hasTotp) throw problem(HttpStatus.CONFLICT, "TWO_FACTOR_ALREADY_ON", "Two-factor is already on. Turn it off first to move it to another phone.");
    const secret = newTotpSecret();
    await this.base
      .update(users)
      .set({ totpPendingSealed: seal(secret, this.config.sealKey), updatedAt: this.now(), updatedBy: p.username })
      .where(eq(users.id, p.userId));
    return { secret, otpauthUrl: otpauthUrl(this.config.issuerLabel, p.username, secret) };
  }

  /**
   * The password is checked like a sign-in (a wrong one counts toward the lockout): without it, a
   * stolen session could attach the thief's phone and lock the owner out. A mistyped first code is
   * not a guess at anything secret, so it does not count. Every other session ends, as on a password change.
   */
  async confirmTotpSetup(p: Principal, input: z.infer<typeof totpChangeSchema>, client: ClientInfo): Promise<{ next: NextStep }> {
    const [user] = await this.base.select().from(users).where(eq(users.id, p.userId));
    if (!user?.totpPendingSealed) throw problem(HttpStatus.CONFLICT, "NO_PENDING_SETUP", "Start the authenticator set-up first.");
    if (user.totpSecretSealed) throw problem(HttpStatus.CONFLICT, "TWO_FACTOR_ALREADY_ON", "Two-factor is already on.");
    if (!(await this.reserveTry(user.id))) throw await this.lockedProblem(user.id);
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      await this.failTry(user, client, await this.openAttempt(user.username, client), "bad_password_two_factor_on");
      throw problem(HttpStatus.BAD_REQUEST, "CURRENT_PASSWORD_WRONG", "Your password is not right.");
    }
    await this.releaseTry(user.id);
    const step = verifyTotp(this.openSecret(user.totpPendingSealed), input.code, this.clock.now(), null);
    if (step === null) throw problem(HttpStatus.BAD_REQUEST, "OTP_INVALID", "That code is not right. Check the time on your phone and try the next code.");
    const now = this.now();
    return this.base.transaction(async (tx) => {
      const [after] = await tx
        .update(users)
        .set({ totpSecretSealed: user.totpPendingSealed, totpPendingSealed: null, totpLastStep: step, updatedAt: now, updatedBy: user.username })
        .where(and(eq(users.id, user.id), isNull(users.totpSecretSealed), eq(users.totpPendingSealed, user.totpPendingSealed!)))
        .returning();
      if (!after) throw problem(HttpStatus.CONFLICT, "NO_PENDING_SETUP", "The set-up changed meanwhile. Start it again.");
      await tx
        .update(userSessions)
        .set({ revokedAt: now, revokeReason: "two_factor_on" })
        .where(and(eq(userSessions.userId, user.id), ne(userSessions.id, p.sessionId), isNull(userSessions.revokedAt)));
      await this.audit.record(tx, {
        actor: user.username,
        action: "auth.two_factor_on",
        subjectType: "user",
        subjectId: user.id,
        before: publicUser(user),
        after: publicUser(after!),
        entityId: await this.homeEntity(user.id),
      });
      return { next: this.nextStep(after!) };
    });
  }

  /**
   * Turning two-factor off (A31) needs the password and a fresh code, both checked like a sign-in:
   * each wrong one counts toward the lockout, and a code works once. A stolen session alone is not enough.
   */
  async disableTotp(p: Principal, input: z.infer<typeof totpChangeSchema>, client: ClientInfo): Promise<{ twoFactor: false }> {
    if (p.isPasswordChangeRequired) {
      throw problem(HttpStatus.FORBIDDEN, "PASSWORD_CHANGE_REQUIRED", "Change your temporary password first.");
    }
    const [user] = await this.base.select().from(users).where(eq(users.id, p.userId));
    if (!user) throw sessionEnded();
    if (!user.totpSecretSealed) throw problem(HttpStatus.CONFLICT, "TWO_FACTOR_OFF", "Two-factor is already off.");
    if (!(await this.reserveTry(user.id))) throw await this.lockedProblem(user.id);
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      await this.failTry(user, client, await this.openAttempt(user.username, client), "bad_password_two_factor_off");
      throw problem(HttpStatus.BAD_REQUEST, "CURRENT_PASSWORD_WRONG", "Your password is not right.");
    }
    const step = verifyTotp(this.openSecret(user.totpSecretSealed), input.code, this.clock.now(), user.totpLastStep);
    if (step === null || !(await this.claimTotpStep(this.base, user.id, step))) {
      await this.failTry(user, client, await this.openAttempt(user.username, client), "bad_otp_two_factor_off");
      throw problem(HttpStatus.BAD_REQUEST, "OTP_INVALID", "That code is wrong or has already been used.");
    }
    await this.releaseTry(user.id);
    const now = this.now();
    return this.base.transaction(async (tx) => {
      const [after] = await tx
        .update(users)
        .set({ totpSecretSealed: null, totpPendingSealed: null, totpLastStep: null, updatedAt: now, updatedBy: user.username })
        .where(eq(users.id, user.id))
        .returning();
      await this.audit.record(tx, {
        actor: user.username,
        action: "auth.two_factor_off",
        subjectType: "user",
        subjectId: user.id,
        before: publicUser(user),
        after: publicUser(after!),
        entityId: await this.homeEntity(user.id),
      });
      return { twoFactor: false as const };
    });
  }

  // ------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------

  private isLive(s: typeof userSessions.$inferSelect, nowMs: number): boolean {
    return s.expiresAt.getTime() > nowMs && s.lastSeenAt.getTime() > nowMs - this.config.idleSec * 1000;
  }

  private session(user: UserRow, sessionId: string, refreshToken: string): Session {
    const iat = Math.floor(this.clock.now() / 1000);
    return {
      accessToken: signAccessToken({ sub: user.id, sid: sessionId, iat, exp: iat + this.config.accessTtlSec }, this.config.accessKey),
      expiresIn: this.config.accessTtlSec,
      refreshToken,
      user: { id: user.id, username: user.username, displayName: user.displayName },
      next: this.nextStep(user),
    };
  }

  private async createSession(tx: Tx, userId: string, client: ClientInfo) {
    const sessionId = Bun.randomUUIDv7();
    const refreshToken = newRefreshToken(sessionId);
    const now = this.now();
    await tx.insert(userSessions).values({
      id: sessionId,
      userId,
      refreshHash: sha256Hex(refreshToken),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + this.config.absoluteSec * 1000),
      ip: client.ip,
      userAgent: client.userAgent?.slice(0, 300) ?? null,
    });
    return { sessionId, refreshToken };
  }

  private async revoke(tx: Tx, sessionId: string, reason: string, at: Date) {
    await tx
      .update(userSessions)
      .set({ revokedAt: at, revokeReason: reason })
      .where(and(eq(userSessions.id, sessionId), isNull(userSessions.revokedAt)));
  }

  /**
   * Reserve one try before verifying (reserve-then-verify): one atomic UPDATE that succeeds only
   * while the account is unlocked and has tries left, so N parallel guesses cannot all slip in
   * before the counter catches up. A right password releases its try; a wrong one keeps it.
   */
  private async reserveTry(userId: string): Promise<boolean> {
    const rows = await this.base
      .update(users)
      .set({ failedSignIns: sql`${users.failedSignIns} + 1` })
      .where(
        and(
          eq(users.id, userId),
          or(isNull(users.lockedUntil), lte(users.lockedUntil, this.now())),
          sql`${users.failedSignIns} < ${this.config.lockAfterFailures}`,
        ),
      )
      .returning({ id: users.id });
    return rows.length === 1;
  }

  private async releaseTry(userId: string): Promise<void> {
    await this.base
      .update(users)
      .set({ failedSignIns: sql`greatest(${users.failedSignIns} - 1, 0)` })
      .where(eq(users.id, userId));
  }

  /** A failed try stays counted; once the tries are used up the account locks and the count restarts. */
  private async failTry(user: UserRow, client: ClientInfo, attemptId: number, reason: string): Promise<void> {
    const now = this.now();
    const lockUntil = new Date(now.getTime() + this.config.lockSec * 1000);
    const limit = this.config.lockAfterFailures;
    const entityId = await this.homeEntity(user.id);
    await this.base.transaction(async (tx) => {
      const [after] = await tx
        .update(users)
        .set({
          lockedUntil: sql`case when ${users.failedSignIns} >= ${limit} then ${lockUntil.toISOString()}::timestamptz else ${users.lockedUntil} end`,
          failedSignIns: sql`case when ${users.failedSignIns} >= ${limit} then 0 else ${users.failedSignIns} end`,
          updatedAt: now,
        })
        .where(eq(users.id, user.id))
        .returning({ lockedUntil: users.lockedUntil });
      await tx.update(loginAttempts).set({ userId: user.id, isSuccess: false, reason }).where(eq(loginAttempts.id, attemptId));
      if (after?.lockedUntil && after.lockedUntil.getTime() === lockUntil.getTime()) {
        await this.audit.record(tx, {
          actor: user.username,
          action: "auth.lockout",
          subjectType: "user",
          subjectId: user.id,
          before: null,
          after: { lockedUntil: lockUntil.toISOString(), ip: client.ip },
          entityId,
        });
      }
    });
  }

  private async lockedProblem(userId: string) {
    const [u] = await this.base.select({ lockedUntil: users.lockedUntil }).from(users).where(eq(users.id, userId));
    const ms = (u?.lockedUntil?.getTime() ?? 0) - this.clock.now();
    return problem(423, "ACCOUNT_LOCKED", "Too many failed sign-ins. This account is locked for a while.", {
      retryAfterSeconds: Math.max(60, Math.ceil(ms / 1000)),
    });
  }

  /** Written before any check (counted as a failure until it is closed as something else). */
  private async openAttempt(username: string, client: ClientInfo): Promise<number> {
    const [row] = await this.base
      .insert(loginAttempts)
      .values({ username: username.slice(0, 100), ip: client.ip, isSuccess: false, reason: "pending", at: this.now() })
      .returning({ id: loginAttempts.id });
    return row!.id;
  }

  private async closeAttempt(id: number, userId: string | null, isSuccess: boolean, reason: string): Promise<void> {
    await this.base.update(loginAttempts).set({ userId, isSuccess, reason }).where(eq(loginAttempts.id, id));
  }

  /**
   * The entity a user's own sign-in events belong to (row-level security on audit_events): the
   * one company they hold roles in, or PLATFORM when they hold roles in several or none.
   */
  async homeEntity(userId: string): Promise<string> {
    const rows = await this.base
      .selectDistinct({ e: userRoles.entityId })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), isNull(userRoles.revokedAt)));
    return rows.length === 1 ? rows[0]!.e : "PLATFORM";
  }

  /** Accept each code once: the step only moves forward, and only one racing request can move it. */
  private async claimTotpStep(orm: Orm, userId: string, step: number): Promise<boolean> {
    const rows = await orm
      .update(users)
      .set({ totpLastStep: step })
      .where(and(eq(users.id, userId), or(isNull(users.totpLastStep), sql`${users.totpLastStep} < ${step}`)))
      .returning({ id: users.id });
    return rows.length === 1;
  }

  private openSecret(sealed: string): string {
    const secret = unseal(sealed, this.config.sealKey);
    // A changed AUTH_SEAL_KEY: fail loudly rather than let anyone in without a second factor.
    if (secret === null) throw new Error("A TOTP secret cannot be opened: AUTH_SEAL_KEY has changed");
    return secret;
  }
}
