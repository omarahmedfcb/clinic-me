// Support sessions, the operator's side (PR 2). Requests are audited by the session table's trigger into the clinic's trail.
import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Req, UnprocessableEntityException, UseGuards } from "@nestjs/common";
import { IsString, Matches, MaxLength } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { refusal } from "../../common/refusals.ts";
import { recordOperatorAction, recordOperatorRead } from "./platform-audit.ts";
import { issueSupportSessionToken, listMySupportSessions, requestSupportSession, withdrawSupportRequest, type OperatorSessionResult } from "./platform-support-sessions.ts";
import { PlatformAuthGuard, type PlatformRequest } from "./platform.guard.ts";

export class RequestSupportSessionDto {
  @IsString() @MaxLength(500) @Matches(/\S/) reason!: string;
}

function unwrap<T>(result: OperatorSessionResult<T>): T {
  if (result.ok) return result.value;
  const body = refusal(result.code, result.params);
  throw result.code === "NOT_FOUND" ? new NotFoundException(body) : new UnprocessableEntityException(body);
}

@Controller("platform/support-sessions")
@UseGuards(PlatformAuthGuard)
export class PlatformSupportSessionsController {
  @Get()
  async mine() {
    const actor = actorContext.getOrThrow();
    const sessions = await listMySupportSessions(actor);
    await recordOperatorRead(actor, { entityType: "support_sessions", entityId: actor.userId, what: `own support sessions (${sessions.length})` });
    return { sessions };
  }

  @Post("clinics/:tenantId")
  async request(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body() body: RequestSupportSessionDto) {
    return unwrap(await requestSupportSession(actorContext.getOrThrow(), tenantId, body.reason, new Date()));
  }

  @Post("clinics/:tenantId/:sessionId/token")
  @HttpCode(200)
  async token(@Req() request: PlatformRequest, @Param("tenantId", ParseUUIDPipe) tenantId: string, @Param("sessionId", ParseUUIDPipe) sessionId: string) {
    const actor = actorContext.getOrThrow();
    const issued = unwrap(await issueSupportSessionToken(actor, tenantId, sessionId, new Date()));
    await recordOperatorAction(actor, { tenantId, action: "UPDATE", entityType: "support_sessions", entityId: sessionId,
      detail: { what: "support token issued", expiresAt: issued.expiresAt.toISOString(), by: request.platformAdmin.fullName } });
    return issued;
  }

  @Post("clinics/:tenantId/:sessionId/withdraw")
  @HttpCode(200)
  async withdraw(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Param("sessionId", ParseUUIDPipe) sessionId: string) {
    return unwrap(await withdrawSupportRequest(actorContext.getOrThrow(), tenantId, sessionId, new Date()));
  }
}
