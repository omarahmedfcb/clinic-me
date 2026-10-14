import { Body, Controller, Get, Put, Req, UseGuards } from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { SaveMessagingSettingsDto } from "./messaging-settings.dto.ts";
import { getMessagingSettings, saveMessagingSettings } from "./messaging-settings.service.ts";

@Controller("clinic-settings/messaging")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class MessagingSettingsController {
  private caller(request: AuthenticatedRequest): CallerContext {
    return {
      tenantId: request.authClaims.tenantId,
      actor: actorContext.getOrThrow(),
      role: request.authClaims.role,
      membershipId: request.authClaims.membershipId,
    };
  }

  @Get()
  @RequirePermission("clinicSettings.manage")
  async read(@Req() request: AuthenticatedRequest) {
    return getMessagingSettings(this.caller(request));
  }

  @Put()
  @RequirePermission("clinicSettings.manage")
  async save(@Req() request: AuthenticatedRequest, @Body() body: SaveMessagingSettingsDto) {
    return saveMessagingSettings(this.caller(request), body);
  }
}
