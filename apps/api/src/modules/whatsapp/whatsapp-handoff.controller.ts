import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { listPausedChats, resumeBot } from "./whatsapp-handoff.ts";

/**
 * The desk's view of human handoff: which WhatsApp chats the bot is paused on, and the button that
 * hands one back. Mapping only. Guarded by `appointments.read`, the same capability as the bell it
 * lives in -- a second rule here would be a copy of the matrix, kept by hand.
 */
@Controller("whatsapp/handoffs")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class WhatsAppHandoffController {
  @Get()
  @RequirePermission("appointments.read")
  async list(@Req() request: AuthenticatedRequest) {
    const items = await listPausedChats(request.authClaims.tenantId, actorContext.getOrThrow());
    return { items };
  }

  @Post(":conversationId/resume")
  @RequirePermission("appointments.read")
  async resume(@Req() request: AuthenticatedRequest, @Param("conversationId", ParseUUIDPipe) conversationId: string) {
    const found = await resumeBot(request.authClaims.tenantId, actorContext.getOrThrow(), conversationId);
    if (!found) throw new NotFoundException({ code: "NOT_FOUND" });
    return { resumed: true };
  }
}
