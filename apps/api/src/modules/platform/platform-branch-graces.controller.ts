// Unresolved grace periods across clinics, deferred ones first: how the operator learns a suspension waits on bookings (6.3).
import { Controller, Get, UseGuards } from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { recordOperatorRead } from "./platform-audit.ts";
import { listUnresolvedGraces } from "./platform-branch-requests.ts";
import { PlatformAuthGuard } from "./platform.guard.ts";

@Controller("platform/branch-limit-graces")
@UseGuards(PlatformAuthGuard)
export class PlatformBranchGracesController {
  @Get()
  async list() {
    const actor = actorContext.getOrThrow();
    const graces = await listUnresolvedGraces(actor);
    await recordOperatorRead(actor, { entityType: "branch_limit_graces", entityId: actor.userId, what: `grace periods (${graces.length})` });
    return { graces };
  }
}
