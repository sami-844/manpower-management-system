import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { from, lastValueFrom, type Observable } from "rxjs";
import { CLOCK, type Clock } from "../common/clock";
import { DB, type Database } from "../db/client";
import { AuthService, type ClientInfo, type Principal } from "./auth.service";
import { AUTH_CONFIG, type AuthConfig } from "./config";
import { ACCESS, type Access } from "./permissions";

export type AuthedRequest = Request & { auth?: Principal };

const problem = (status: number, code: string, message: string) => new HttpException({ code, message }, status);

export function bearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  return header?.startsWith("Bearer ") ? header.slice(7).trim() || undefined : undefined;
}

export function clientInfo(req: Request): ClientInfo {
  return { ip: req.ip ?? null, userAgent: req.header("user-agent") ?? null };
}

/**
 * Per-user request ceiling (TR-SEC-11: 600 a minute).
 * ponytail: in-process fixed window; per API instance, so N instances allow N×600. Move the counter
 * to Redis (already in the stack for BullMQ) when the API runs on more than one task.
 */
class RequestLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  hit(userId: string, nowMs: number, limit: number): boolean {
    const w = this.windows.get(userId);
    if (!w || nowMs - w.start >= 60_000) {
      if (this.windows.size > 10_000) this.windows.clear();
      this.windows.set(userId, { start: nowMs, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= limit;
  }
}

/** Default deny (TR-SEC-04): a route with no declared access is refused, whoever calls it. */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly limiter = new RequestLimiter();

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS, [ctx.getHandler(), ctx.getClass()]);
    if (!access) throw problem(HttpStatus.FORBIDDEN, "ACCESS_NOT_DECLARED", "This route declares no access rule.");
    if (access.kind === "public") return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(req);
    if (!token) throw problem(HttpStatus.UNAUTHORIZED, "TOKEN_MISSING", "Sign in first.");
    const principal = await this.auth.authenticate(token, req.header("x-entity-id") ?? undefined);

    if (!this.limiter.hit(principal.userId, this.clock.now(), this.config.requestsPerMinute)) {
      throw problem(HttpStatus.TOO_MANY_REQUESTS, "RATE_LIMITED", "Too many requests. Wait a moment.");
    }

    if (access.kind === "permission") {
      if (principal.isPasswordChangeRequired) {
        throw problem(HttpStatus.FORBIDDEN, "PASSWORD_CHANGE_REQUIRED", "Change your temporary password first.");
      }
      if (principal.entityId === null) {
        throw problem(
          HttpStatus.FORBIDDEN,
          principal.entityChoices.length > 1 ? "ENTITY_REQUIRED" : "NO_ROLE",
          principal.entityChoices.length > 1 ? "Choose the company to work in." : "You have no role yet. Ask the system admin.",
        );
      }
      if (!principal.permissions.has(access.key)) {
        throw problem(HttpStatus.FORBIDDEN, "FORBIDDEN", "Your role does not allow this.");
      }
    }
    req.auth = principal;
    return true;
  }
}

/**
 * Runs every permission route in one transaction as `mms_app`, with the entity and user set,
 * so PostgreSQL row-level security scopes every query (TR-SEC-05). Public routes run unscoped, and
 * so do the `@SignedIn` routes (a user's own account: me, password, two-factor): they touch no
 * company data and do their sign-in bookkeeping on the base connection, so holding a request
 * transaction as well would take two pooled connections each, and ten at once would freeze the pool.
 */
@Injectable()
export class RequestScopeInterceptor implements NestInterceptor {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const access = this.reflector.getAllAndOverride<Access | undefined>(ACCESS, [ctx.getHandler(), ctx.getClass()]);
    if (access?.kind !== "permission") return next.handle();
    const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!auth?.entityId) return next.handle();
    return from(this.db.inRequestScope({ entityId: auth.entityId, userId: auth.userId }, () => lastValueFrom(next.handle(), { defaultValue: undefined })));
  }
}
