import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import {
  summariseAttachmentsForReception,
  type AttachmentCaller,
} from "./attachments.service.ts";

/**
 * The one reception-facing attachment route — ruled by the founder 2026-09-05.
 *
 * ## Why this is its own controller
 *
 * `AttachmentsController` states, in its own documentation, that **every route on it is
 * doctor-only**, and that claim is load-bearing: it is why "a reception token cannot fetch
 * attachment content" is provable with a token and no fixtures. Hanging a reception route off that
 * class would make the sentence false and leave the next reader to work out which of its methods
 * the exception applies to.
 *
 * A separate controller keeps both statements true and checkable: everything on that class is
 * `visits.write` or `visits.readContent`, and everything on this one is `visits.readIndex`.
 *
 * ## `visits.readIndex`, and why no new capability was needed
 *
 * `visits.readIndex` is already `FULL` for `RECEPTIONIST` and already serves reception the visit
 * *index* — dates, doctor, service — at `GET /patients/:id/visits`. "Which documents exist" is the
 * same class of fact as "which visits happened": operational metadata about a record whose contents
 * stay behind `visits.readContent`. Reusing it means no permission-matrix change, and it puts this
 * route under a capability whose meaning already matches what it does.
 *
 * ## It joins the leak sweep, and it must stay there
 *
 * A reception-facing endpoint that reads from a clinical table is exactly what
 * `clinical-leak-guard.integration.spec.ts` exists to police. It is registered there, and the sweep
 * checks the raw response text for sentinel clinical content — which is the check that catches a
 * filename arriving through a relation nobody audited.
 */
@Controller()
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class AttachmentsSummaryController {
  private caller(request: AuthenticatedRequest): AttachmentCaller {
    return {
      tenantId: request.authClaims.tenantId,
      actor: actorContext.getOrThrow(),
      membershipId: request.authClaims.membershipId,
    };
  }

  /**
   * Which documents are on file for this patient, and nothing about what they say.
   *
   * Deliberately **not** mounted at `/patients/:id/attachments` beside the doctor's list. Two routes
   * differing only by verb or suffix, one doctor-only and one not, is a distinction a later reader
   * has to notice; a different noun is one they cannot miss.
   */
  @Get("patients/:id/attachment-summary")
  @RequirePermission("visits.readIndex")
  async summary(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const result = await summariseAttachmentsForReception(this.caller(request), id);
    if (result.ok) return result.value;
    const body = refusal(result.code, result.params);
    if (result.code === "NOT_FOUND") throw new NotFoundException(body);
    throw new BadRequestException(body);
  }
}
