// The clinic's side of the raise-limit request (step 6.2): ask, list, withdraw. Clinic-level, like every setting.
import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Req, UnprocessableEntityException, UseGuards } from "@nestjs/common";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { listBranchRequests, requestBranchLimit, withdrawBranchRequest, type RequestResult } from "./branch-requests.ts";

export class RequestBranchLimitDto {
  @IsInt() @Min(2) @Max(100) requestedLimit!: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

@Controller("branch-requests")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class BranchRequestsController {
  private caller(request: AuthenticatedRequest) {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  private unwrap<T>(result: RequestResult<T>): T {
    if (result.ok) return result.value;
    const body = refusal(result.code, result.params);
    if (result.code === "NOT_FOUND") throw new NotFoundException(body);
    throw new UnprocessableEntityException(body);
  }

  @Get()
  @RequirePermission("clinicSettings.manage")
  async list(@Req() request: AuthenticatedRequest) {
    return listBranchRequests(this.caller(request));
  }

  @Post()
  @RequirePermission("clinicSettings.manage")
  async create(@Req() request: AuthenticatedRequest, @Body() body: RequestBranchLimitDto) {
    return this.unwrap(await requestBranchLimit(this.caller(request), body));
  }

  @Post(":id/withdraw")
  @RequirePermission("clinicSettings.manage")
  async withdraw(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    return this.unwrap(await withdrawBranchRequest(this.caller(request), id));
  }
}
