import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { listComplaints, resolveComplaint } from "./complaints.service.ts";

export class ComplaintsQueryDto {
  @IsOptional() @IsIn(["OPEN", "RESOLVED"]) status?: "OPEN" | "RESOLVED";
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/** «الشكاوى» — what patients reported over WhatsApp (bot.service.ts's createComplaint files these).
 *  OWNER and ADMIN only, same pairing as the audit log: RECEPTIONIST and DOCTOR do not get a new
 *  inbox neither asked for. */
@Controller("complaints")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class ComplaintsController {
  private caller(request: AuthenticatedRequest) {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  @Get()
  @RequirePermission("complaints.read")
  async list(@Req() request: AuthenticatedRequest, @Query() query: ComplaintsQueryDto) {
    return listComplaints(this.caller(request), query);
  }

  @Post(":id/resolve")
  @RequirePermission("complaints.manage")
  async resolve(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const result = await resolveComplaint(this.caller(request), id, new Date());
    if (!result.ok) throw new NotFoundException(refusal("NOT_FOUND", { resource: "complaint" }));
    return { resolved: true };
  }
}
