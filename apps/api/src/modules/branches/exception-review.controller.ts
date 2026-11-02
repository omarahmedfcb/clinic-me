// The clinic admin's review of future-dated exceptions after creating a branch (step 6.6). The screen is step 8.
import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Put, Req, UnprocessableEntityException, UseGuards } from "@nestjs/common";
import { IsIn } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import type { ScheduleCaller } from "../schedules/schedules.service.ts";
import { decideExceptionReview, listExceptionReview } from "./exception-review.ts";

export class DecideExceptionReviewDto {
  @IsIn(["KEEP", "COPY_TO_NEW_BRANCH"]) decision!: "KEEP" | "COPY_TO_NEW_BRANCH";
}

@Controller("branches/:branchId/exception-review")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class ExceptionReviewController {
  private caller(request: AuthenticatedRequest): ScheduleCaller {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow(), role: request.authClaims.role, membershipId: request.authClaims.membershipId };
  }

  @Get()
  @RequirePermission("clinicSettings.manage")
  async list(@Req() request: AuthenticatedRequest, @Param("branchId", ParseUUIDPipe) branchId: string) {
    return { items: await listExceptionReview(this.caller(request), branchId) };
  }

  @Put(":reviewId")
  @RequirePermission("clinicSettings.manage")
  async decide(
    @Req() request: AuthenticatedRequest,
    @Param("branchId", ParseUUIDPipe) branchId: string,
    @Param("reviewId", ParseUUIDPipe) reviewId: string,
    @Body() body: DecideExceptionReviewDto,
  ) {
    const result = await decideExceptionReview(this.caller(request), branchId, reviewId, body.decision);
    if (result.ok) return result.value;
    const refused = refusal(result.code, result.params);
    if (result.code === "NOT_FOUND") throw new NotFoundException(refused);
    if (result.code === "SCOPE_TOO_NARROW") throw new ForbiddenException(refused);
    if (result.code === "ALREADY_DECIDED" || result.code === "INVALID_FIELD") throw new UnprocessableEntityException(refused);
    throw new BadRequestException(refused);
  }
}
