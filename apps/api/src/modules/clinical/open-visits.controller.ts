// The doctor's own open consultations — Q35's tab bar. A read, and the doctor's own list only.
// Its own controller because `ClinicalController` is mounted at `appointments/:id` and this has no id.

import { Controller, Get, Req, UseGuards } from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { listOpenVisits } from "./open-visits.ts";

@Controller("visits")
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class OpenVisitsController {
  /** `visits.write` is DOCTOR-only, and this list is about the caller's own unfinished work. */
  @Get("open")
  @RequirePermission("visits.write")
  async open(@Req() request: AuthenticatedRequest) {
    const caller: CallerContext = {
      tenantId: request.authClaims.tenantId,
      actor: actorContext.getOrThrow(),
      role: request.authClaims.role,
      membershipId: request.authClaims.membershipId,
    };
    return listOpenVisits(caller, new Date());
  }
}
