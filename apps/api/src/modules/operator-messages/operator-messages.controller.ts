// The clinic admin's side of operator messages (step 6.4). Clinic-level: a message is to the clinic, not a branch.
import { Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { listInbox, markRead, unreadCount } from "./operator-messages.ts";

@Controller("operator-messages")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class OperatorMessagesController {
  private caller(request: AuthenticatedRequest) {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  @Get()
  @RequirePermission("clinicSettings.manage")
  async inbox(@Req() request: AuthenticatedRequest) {
    return listInbox(this.caller(request));
  }

  @Get("unread")
  @RequirePermission("clinicSettings.manage")
  async unread(@Req() request: AuthenticatedRequest) {
    return { unread: await unreadCount(this.caller(request)) };
  }

  @Post(":id/read")
  @HttpCode(200)
  @RequirePermission("clinicSettings.manage")
  async read(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    if (!(await markRead(this.caller(request), id))) throw new NotFoundException(refusal("NOT_FOUND", { resource: "operatorMessage" }));
    return { read: true };
  }
}
