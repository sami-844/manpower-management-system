import { Body, Controller, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { RequirePermission } from "../auth/permissions";
import { Actor } from "../common/actor";
import { parse, parseId } from "../common/validation";
import { checkSchema, ComplianceService, overrideSchema } from "./compliance.service";

@Controller("api")
export class ComplianceController {
  constructor(@Inject(ComplianceService) private readonly compliance: ComplianceService) {}

  @RequirePermission("compliance.check")
  @Post("compliance/check")
  @HttpCode(200)
  check(@Body() body: unknown) {
    return this.compliance.check(parse(checkSchema, body));
  }

  @RequirePermission("compliance.renewals")
  @Get("compliance/renewals")
  renewals() {
    return this.compliance.renewals();
  }

  @RequirePermission("overrides.create")
  @Post("workers/:id/overrides")
  addOverride(@Param("id") id: string, @Body() body: unknown, @Actor() actor: string) {
    return this.compliance.addOverride(parseId(id), parse(overrideSchema, body), actor);
  }

  @RequirePermission("dashboard.read")
  @Get("dashboard/summary")
  summary() {
    return this.compliance.summary();
  }
}
