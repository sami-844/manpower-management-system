import "reflect-metadata";
import { Controller, Get, Global, Inject, Module, type INestApplication, type OnApplicationShutdown } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import type { Express } from "express";
import { AuditController } from "./audit/audit.controller";
import { AuditService } from "./audit/audit.service";
import { AdminUsersController, AdminUsersService } from "./auth/admin-users";
import { AuthController } from "./auth/auth.controller";
import { AuthGuard, RequestScopeInterceptor } from "./auth/auth.guard";
import { AuthService } from "./auth/auth.service";
import { AUTH_CONFIG, loadAuthConfig } from "./auth/config";
import { Public } from "./auth/permissions";
import { CLOCK, omanClock } from "./common/clock";
import { ComplianceController } from "./compliance/compliance.controller";
import { ComplianceService } from "./compliance/compliance.service";
import { createDatabase, DB, type Database } from "./db/client";
import { SitesModule } from "./sites/sites.module";
import { WorkersController } from "./workers/workers.controller";
import { WorkersService } from "./workers/workers.service";

@Controller("api/health")
class HealthController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Public()
  @Get()
  async health() {
    await this.db.sql`select 1`;
    return { status: "ok" };
  }
}

@Global()
@Module({
  providers: [
    { provide: DB, useFactory: () => createDatabase() },
    { provide: CLOCK, useValue: omanClock },
    { provide: AUTH_CONFIG, useFactory: () => loadAuthConfig() },
    AuditService,
    AuthService,
  ],
  exports: [DB, CLOCK, AUTH_CONFIG, AuditService, AuthService],
})
class CoreModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Database) {}

  async onApplicationShutdown() {
    await this.db.sql.end({ timeout: 5 });
  }
}

@Module({
  imports: [CoreModule, SitesModule],
  controllers: [HealthController, AuthController, AdminUsersController, AuditController, WorkersController, ComplianceController],
  providers: [
    WorkersService,
    ComplianceService,
    AdminUsersService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: RequestScopeInterceptor },
  ],
})
export class AppModule {}

const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

/** Shared by main.ts and tests so both run the same HTTP setup. */
export function configureApp(app: INestApplication): void {
  const configured = process.env.WEB_ORIGIN?.split(",").map((o) => o.trim()).filter(Boolean);
  if (!configured?.length && process.env.NODE_ENV === "production") {
    throw new Error("WEB_ORIGIN must list the web app's origins in production");
  }
  // Credentials (the refresh cookie) only ever go to origins named here, never to "any origin".
  app.enableCors({ origin: configured?.length ? configured : DEV_ORIGINS, credentials: true });
  // Behind a load balancer, TRUST_PROXY is the number of proxies in front, so req.ip is the client.
  if (process.env.TRUST_PROXY) {
    (app.getHttpAdapter().getInstance() as Express).set("trust proxy", Number(process.env.TRUST_PROXY));
  }
  app.enableShutdownHooks();
}
