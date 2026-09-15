import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { IsArray, IsUUID, ArrayMaxSize } from "class-validator";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import {
  listNotifications,
  markRead,
  unreadCount,
  type NotificationCaller,
} from "./notifications.service.ts";

export class MarkReadDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID("all", { each: true })
  ids!: string[];
}

/**
 * Mapping only.
 *
 * `membershipId` comes from the validated token, never from the request — read state is per
 * membership (PHASE-2.md §16), so a caller who could name their own membership could mark
 * somebody else's notifications read.
 *
 * Guarded by `appointments.write`, which is the capability §8 already grants to every role that
 * should see a booking. A second visibility rule here would be a copy of the matrix, kept by hand,
 * free to drift.
 */
@Controller("notifications")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class NotificationsController {
  private caller(request: AuthenticatedRequest): NotificationCaller {
    return {
      tenantId: request.authClaims.tenantId,
      membershipId: request.authClaims.membershipId,
      actor: actorContext.getOrThrow(),
    };
  }

  /** Polled every 15 seconds by the bell. Deliberately the cheapest query in the module. */
  @Get("count")
  @RequirePermission("appointments.read")
  async count(@Req() request: AuthenticatedRequest) {
    return { unread: await unreadCount(this.caller(request)) };
  }

  @Get()
  @RequirePermission("appointments.read")
  async list(@Req() request: AuthenticatedRequest, @Query("limit") limit?: string) {
    const parsed = Number(limit);
    const items = await listNotifications(
      this.caller(request),
      Number.isFinite(parsed) && parsed > 0 ? parsed : 50,
    );
    return { items };
  }

  @Post("read")
  @RequirePermission("appointments.read")
  async read(@Req() request: AuthenticatedRequest, @Body() body: MarkReadDto) {
    return { marked: await markRead(this.caller(request), body.ids) };
  }
}
