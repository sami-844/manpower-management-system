import { createParamDecorator, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
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
