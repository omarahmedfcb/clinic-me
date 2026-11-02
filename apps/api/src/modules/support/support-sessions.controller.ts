// Support sessions, the clinic's side (PR 2). Admins open, approve, deny and renew; every staff member sees the live one and
// may end it (appointments.read: every role but the bot). With the switch off, every route is the 404 of a feature not there.
import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Req, UnprocessableEntityException, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, IsUUID, Matches, MaxLength } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { allowChanges, changeSession, listSessions, liveSession, openSession, type SessionResult } from "./support-sessions.ts";

export class OpenSupportSessionDto {
  @IsUUID() operatorId!: string;
  @IsString() @MaxLength(500) @Matches(/\S/) reason!: string;
}

export class EndSupportSessionDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

const absent = () => new NotFoundException(refusal("NOT_FOUND", { resource: "supportSession" }));

@Controller("support-sessions")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class SupportSessionsController {
  private caller(request: AuthenticatedRequest) {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  private unwrap<T>(result: SessionResult<T>): T {
    if (result.ok) return result.value;
    if (result.code === "NOT_FOUND") throw absent();
    throw new UnprocessableEntityException(refusal(result.code, result.params));
  }

  @Get()
  @RequirePermission("clinicSettings.manage")
  async list(@Req() request: AuthenticatedRequest) {
    const sessions = await listSessions(this.caller(request), new Date());
    if (sessions === null) throw absent();
    return { sessions };
  }

  @Get("live")
  @RequirePermission("appointments.read")
  async live(@Req() request: AuthenticatedRequest) {
    return { session: await liveSession(this.caller(request), new Date()) };
  }

  @Post()
  @RequirePermission("clinicSettings.manage")
  async open(@Req() request: AuthenticatedRequest, @Body() body: OpenSupportSessionDto) {
    return this.unwrap(await openSession(this.caller(request), body, new Date()));
  }

  @Post(":id/approve")
  @HttpCode(200)
  @RequirePermission("clinicSettings.manage")
  async approve(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.unwrap(await changeSession(this.caller(request), id, "approve", new Date()));
  }

  @Post(":id/deny")
  @HttpCode(200)
  @RequirePermission("clinicSettings.manage")
  async deny(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: EndSupportSessionDto) {
    return this.unwrap(await changeSession(this.caller(request), id, "deny", new Date(), body.reason));
  }

  @Post(":id/renew")
  @HttpCode(200)
  @RequirePermission("clinicSettings.manage")
  async renew(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.unwrap(await changeSession(this.caller(request), id, "renew", new Date()));
  }

  @Post(":id/end")
  @HttpCode(200)
  @RequirePermission("appointments.read")
  async end(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string, @Body() body: EndSupportSessionDto) {
    return this.unwrap(await changeSession(this.caller(request), id, "end", new Date(), body.reason));
  }

  @Post(":id/allow-changes")
  @HttpCode(200)
  @RequirePermission("clinicSettings.manage")
  async allowChanges(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.unwrap(await allowChanges(this.caller(request), id, new Date()));
  }
}
