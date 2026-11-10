import { createParamDecorator, HttpException, HttpStatus, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import type { AuthedRequest } from "../auth/auth.guard";

/**
 * Who is acting: the signed-in user's username, set by AuthGuard from a verified access token.
 * Every audit entry is attributed through this, never through anything the client sends.
 */
export const Actor = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw new UnauthorizedException("A signed-in user is required for this action");
  return auth.username;
});

/** The signed-in user's permissions in this request's entity, for rules finer than one route's permission. */
export const Grants = createParamDecorator((_: unknown, ctx: ExecutionContext): ReadonlySet<string> => {
  const auth = ctx.switchToHttp().getRequest<AuthedRequest>().auth;
  if (!auth) throw new UnauthorizedException("A signed-in user is required for this action");
  return auth.permissions;
});

/**
 * Recording a document as already verified is a verification, so it needs documents.verify too:
 * otherwise anyone allowed to record a document could mark their own entry as checked.
 */
export function assertMayVerify(verified: boolean, grants: ReadonlySet<string>): void {
  if (verified && !grants.has("documents.verify")) {
    throw new HttpException(
      { code: "VERIFY_NOT_ALLOWED", message: "Only someone who may verify documents can record one as verified." },
      HttpStatus.FORBIDDEN,
    );
  }
}
