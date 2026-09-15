import { Controller, Get, Query, Req, UseGuards } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { auditFilterOptions, listAuditLog } from "./audit.service.ts";

/** A calendar day, not an instant: the filter is "which days", and a day has no timezone here. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class AuditQueryDto {
  @IsOptional() @IsUUID() actorUserId?: string;
  @IsOptional() @IsString() @MaxLength(100) entityType?: string;
  @IsOptional() @Matches(DAY) from?: string;
  @IsOptional() @Matches(DAY) to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) offset?: number;
}

/**
 * The audit log viewer — Phase 5 PR 11. **Read-only, and there is no write route here at all.**
 *
 * `audit_logs` is append-only by trigger (D5) and tenant-isolated by RLS (D17), so neither property
 * depends on this controller behaving. What this controller adds is the §8 boundary: field names
 * travel and values do not, because the roles holding `auditLog.read` hold `visits.readContent: NONE`.
 */
@Controller("audit-log")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class AuditController {
  private caller(request: AuthenticatedRequest) {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  /** Declared before nothing parameterised, but kept first for the same reason `/recent` is. */
  @Get("filters")
  @RequirePermission("auditLog.read")
  async filters(@Req() request: AuthenticatedRequest) {
    return auditFilterOptions(this.caller(request));
  }

  @Get()
  @RequirePermission("auditLog.read")
  async list(@Req() request: AuthenticatedRequest, @Query() query: AuditQueryDto) {
    return listAuditLog(this.caller(request), query);
  }
}
