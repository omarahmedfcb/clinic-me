// The operator's raise-limit queue (step 6.2). Decisions are audited into the clinic's own trail; the console screen is step 9.
import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Req, UnprocessableEntityException, UseGuards } from "@nestjs/common";
import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { refusal } from "../../common/refusals.ts";
import { recordOperatorAction, recordOperatorRead } from "./platform-audit.ts";
import { decideBranchRequest, listBranchRequestQueue } from "./platform-branch-requests.ts";
import { PlatformAuthGuard, type PlatformRequest } from "./platform.guard.ts";

export class DecideBranchRequestDto {
  @IsBoolean() approve!: boolean;
  /** Required to reject; the clinic is told why. */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

@Controller("platform/branch-requests")
@UseGuards(PlatformAuthGuard)
export class PlatformBranchRequestsController {
  @Get()
  async queue() {
    const actor = actorContext.getOrThrow();
    const requests = await listBranchRequestQueue(actor);
    await recordOperatorRead(actor, { entityType: "branch_requests", entityId: actor.userId, what: `branch request queue (${requests.length})` });
    return { requests };
  }

  @Post(":requestId/decision")
  @HttpCode(200)
  async decide(@Req() request: PlatformRequest, @Param("requestId", ParseUUIDPipe) requestId: string, @Body() body: DecideBranchRequestDto) {
    const actor = actorContext.getOrThrow();
    const result = await decideBranchRequest(actor, requestId, body);
    if (!result.ok) {
      const refused = refusal(result.code, result.params);
      throw result.code === "NOT_FOUND" ? new NotFoundException(refused) : new UnprocessableEntityException(refused);
    }
    await recordOperatorAction(actor, {
      tenantId: result.value.tenantId,
      action: "UPDATE",
      entityType: "branch_requests",
      entityId: requestId,
      detail: { status: result.value.status, maxBranches: result.value.maxBranches, reason: body.reason ?? null, by: request.platformAdmin.fullName },
    });
    return result.value;
  }
}
