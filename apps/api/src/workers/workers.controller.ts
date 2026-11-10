import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { RequirePermission } from "../auth/permissions";
import { Actor, assertMayVerify, Grants } from "../common/actor";
import { parse, parseId } from "../common/validation";
import {
  addDocumentSchema,
  addLeaveSchema,
  createWorkerSchema,
  listWorkersSchema,
  WorkersService,
} from "./workers.service";

@Controller("api")
export class WorkersController {
  constructor(@Inject(WorkersService) private readonly workers: WorkersService) {}

  @RequirePermission("workers.read")
  @Get("workers")
  list(@Query() query: unknown) {
    return this.workers.list(parse(listWorkersSchema, query));
  }

  @RequirePermission("workers.create")
  @Post("workers")
  create(@Body() body: unknown, @Actor() actor: string) {
    return this.workers.create(parse(createWorkerSchema, body), actor);
  }

  @RequirePermission("workers.read")
  @Get("workers/:id")
  get(@Param("id") id: string) {
    return this.workers.get(parseId(id));
  }

  @RequirePermission("documents.create")
  @Post("workers/:id/documents")
  addDocument(@Param("id") id: string, @Body() body: unknown, @Actor() actor: string, @Grants() grants: ReadonlySet<string>) {
    const input = parse(addDocumentSchema, body);
    assertMayVerify(input.verified, grants);
    return this.workers.addDocument(parseId(id), input, actor);
  }

  @RequirePermission("leave.create")
  @Post("workers/:id/leave")
  addLeave(@Param("id") id: string, @Body() body: unknown, @Actor() actor: string) {
    return this.workers.addLeave(parseId(id), parse(addLeaveSchema, body), actor);
  }

  @RequirePermission("documents.verify")
  @Patch("documents/:id/verify")
  @HttpCode(200)
  verify(@Param("id") id: string, @Actor() actor: string) {
    return this.workers.verifyDocument(parseId(id), actor);
  }
}
