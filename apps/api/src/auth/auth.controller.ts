import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { parse } from "../common/validation";
import { bearerToken, clientInfo, type AuthedRequest } from "./auth.guard";
import { AuthService, changePasswordSchema, signInSchema, totpCodeSchema, type Session } from "./auth.service";
import { AUTH_CONFIG, REFRESH_COOKIE, REFRESH_COOKIE_PATH, type AuthConfig } from "./config";
import { Public, SignedIn } from "./permissions";

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.header("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

@Controller("api/auth")
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /** The refresh token travels only in this cookie, never in a response body (TR-SEC-03). */
  private respond(res: Response, s: Session) {
    res.cookie(REFRESH_COOKIE, s.refreshToken, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: "strict",
      path: REFRESH_COOKIE_PATH,
      maxAge: this.config.absoluteSec * 1000,
    });
    res.setHeader("Cache-Control", "no-store");
    return { accessToken: s.accessToken, expiresIn: s.expiresIn, user: s.user, next: s.next };
  }

  private clear(res: Response) {
    res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure: this.config.cookieSecure, sameSite: "strict", path: REFRESH_COOKIE_PATH });
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.signIn(parse(signInSchema, body), clientInfo(req)));
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      return this.respond(res, await this.auth.refresh(readCookie(req, REFRESH_COOKIE) ?? "", clientInfo(req)));
    } catch (err) {
      this.clear(res);
      throw err;
    }
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.signOut(bearerToken(req), readCookie(req, REFRESH_COOKIE));
    this.clear(res);
  }

  @SignedIn()
  @Get("me")
  me(@Req() req: AuthedRequest) {
    return this.auth.me(req.auth!);
  }

  @SignedIn()
  @Post("change-password")
  @HttpCode(200)
  changePassword(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.auth.changePassword(req.auth!, parse(changePasswordSchema, body), clientInfo(req));
  }

  @SignedIn()
  @Post("2fa/setup")
  @HttpCode(200)
  setupTotp(@Req() req: AuthedRequest) {
    return this.auth.startTotpSetup(req.auth!);
  }

  @SignedIn()
  @Post("2fa/confirm")
  @HttpCode(200)
  confirmTotp(@Body() body: unknown, @Req() req: AuthedRequest) {
    return this.auth.confirmTotpSetup(req.auth!, parse(totpCodeSchema, body).code);
  }
}
