// The clinic's side of a lowered limit (step 6.3): what is over, by when, and the admin's choice. The notice bar is step 8.
import { Body, Controller, Get, Put, Req, UnprocessableEntityException, UseGuards } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsUUID } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { chooseBranchesToSuspend, getLimitStatus } from "./branch-limit-grace.ts";

export class ChooseBranchesDto {
  @IsArray() @ArrayMaxSize(100) @IsUUID("all", { each: true }) branchIds!: string[];
}

@Controller("branch-limit")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class BranchLimitController {
  private caller(request: AuthenticatedRequest) {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  @Get()
  @RequirePermission("clinicSettings.manage")
  async status(@Req() request: AuthenticatedRequest) {
    return getLimitStatus(this.caller(request), new Date());
  }

  @Put("choice")
  @RequirePermission("clinicSettings.manage")
  async choose(@Req() request: AuthenticatedRequest, @Body() body: ChooseBranchesDto) {
    const result = await chooseBranchesToSuspend(this.caller(request), body.branchIds);
    if (!result.ok) throw new UnprocessableEntityException(refusal(result.code, result.params));
    return result.value;
  }
}
