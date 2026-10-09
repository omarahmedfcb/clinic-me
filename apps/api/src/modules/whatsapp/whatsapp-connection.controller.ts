import { BadGatewayException, BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { readConnectionSummary } from "./whatsapp-connections.ts";
import { reconnectWhatsApp } from "./whatsapp-reconnect.ts";

export class ReconnectDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2048)
  code!: string;

  @IsString()
  @Matches(/^\d{5,32}$/)
  wabaId!: string;

  // Absent on a coexistence completion event; the server finds the number itself then.
  @IsOptional()
  @IsString()
  @Matches(/^\d{5,32}$/)
  phoneNumberId?: string;
}

/**
 * The clinic's own WhatsApp connection: is it working, and the way back when it is not. Owner and
 * admin only (`clinicSettings.manage`) -- it is the clinic's credential, not the desk's.
 */
@Controller("whatsapp/connection")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class WhatsAppConnectionController {
  /** `null` for a clinic with no connection row (the .env test number): nothing to show. */
  @Get()
  @RequirePermission("clinicSettings.manage")
  async summary(@Req() request: AuthenticatedRequest) {
    return { connection: await readConnectionSummary(request.authClaims.tenantId, actorContext.getOrThrow()) };
  }

  @Post("reconnect")
  @RequirePermission("clinicSettings.manage")
  async reconnect(@Req() request: AuthenticatedRequest, @Body() body: ReconnectDto) {
    const result = await reconnectWhatsApp(
      { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() },
      body,
    );
    if (result.ok) return { reconnected: true };
    if (result.reason === "META_SETUP_FAILED") throw new BadGatewayException({ reason: result.reason });
    throw new BadRequestException({ reason: result.reason });
  }
}
