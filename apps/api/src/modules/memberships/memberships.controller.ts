import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import { listMemberships, type MembershipCaller } from "./memberships.service.ts";

/**
 * `GET /memberships` — who works at this clinic. Ruled 2026-09-05.
 *
 * Mapping only; the service is the interface.
 *
 * **`users.manage`, which is OWNER and ADMIN only.** The list carries names, emails and phone
 * numbers of staff, which is not the same class of fact as "which doctors can be booked" — that is
 * what `GET /doctors` is for, and it is readable under `appointments.write` because reception picks
 * a doctor when booking. Reception has no reason to hold a directory of everyone's contact details.
 *
 * There is deliberately no POST. Nothing in this API creates a user, and an endpoint that could
 * create a membership for a user who cannot exist would be a route to a dead end.
 */
@Controller("memberships")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class MembershipsController {
  private caller(request: AuthenticatedRequest): MembershipCaller {
    return { tenantId: request.authClaims.tenantId, actor: actorContext.getOrThrow() };
  }

  @Get()
  @RequirePermission("users.manage")
  async list(@Req() request: AuthenticatedRequest) {
    return listMemberships(this.caller(request));
  }
}
