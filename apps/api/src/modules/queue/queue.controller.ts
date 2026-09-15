import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import { PendingNoShowsQueryDto, QueueMoveDto, QueueTodayQueryDto } from "./queue.dto.ts";
import {
  checkIn,
  completeConsultation,
  describeQueueForDate,
  markNoShow,
  pauseConsultation,
  resumeConsultation,
  pendingNoShowsForDate,
  startConsultation,
  type QueueMoveResult,
} from "./queue.service.ts";

/**
 * The HTTP face of the queue service. **Mapping only.**
 *
 * No business logic, on the same terms as `appointments.controller.ts`: the AI tool layer
 * (ARCHITECTURE.md §12) calls the service directly and would never see logic that lived here.
 * Every method builds a `CallerContext`, calls one service function, and turns its result into a
 * status code.
 *
 * ## Why `QUEUE_MOVED_ON` is 409 with a body, not a bare message
 *
 * Losing a compare-and-set is the design working, not a fault: someone else moved the patient
 * while this screen was showing the older state. The response carries `currentStatus` and
 * `movedBy` so reception can be told *what happened* — "Dr Hisham already started this patient" —
 * rather than "illegal transition". Q2 makes that the point of the mechanism rather than a nicety,
 * so the data it needs is in the response rather than left for a second request to discover.
 *
 * ## No ownership checks
 *
 * A tenant-scoped lookup returning `NOT_FOUND` becomes 404, never 403 (PHASE-1 §2b). Writing an
 * ownership check would mean first reading a row the caller is not entitled to see, and its 403
 * would confirm the record exists.
 */
@Controller()
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class QueueController {
  private caller(request: AuthenticatedRequest): CallerContext {
    return {
      tenantId: request.authClaims.tenantId,
      actor: actorContext.getOrThrow(),
      // From the validated token, never the request -- the same rule as tenantId. `own` cannot be
      // decided without them; see common/doctor-scope.ts.
      role: request.authClaims.role,
      membershipId: request.authClaims.membershipId,
    };
  }

  /**
   * Turns a refusal into a status code. One place, so four endpoints cannot disagree about what a
   * refusal means — and so adding a reason to `QueueRefusalReason` surfaces here as a decision.
   */
  private refuse(result: Extract<QueueMoveResult, { ok: false }>): never {
    const body = refusal(result.code, result.params);
    switch (result.code) {
      case "NOT_FOUND":
        throw new NotFoundException(body);

      case "QUEUE_MOVED_ON":
        // `currentStatus` and `movedBy` ride alongside the refusal body rather than inside
        // `params`: they are what the screen acts on -- refresh to this status, name this person --
        // not values the Arabic substitutes.
        throw new ConflictException({
          ...body,
          currentStatus: result.currentStatus,
          movedBy: result.movedBy,
        });

      case "NOT_PERMITTED":
        // Q34. Not a conflict with the row's state — the caller may not do this at all, and the
        // appointment's existence is not being hidden: it is on the board in front of them.
        throw new ForbiddenException(body);

      case "REASON_REQUIRED":
        // The request is malformed rather than out of date: it is missing something the caller
        // can supply and retry with.
        throw new BadRequestException(body);

      default:
        // ILLEGAL_TRANSITION, TERMINAL_STATUS, GRACE_PERIOD_NOT_ELAPSED, MISSING_CONTEXT.
        // All conflicts with the record's current state, not malformed requests: completing an
        // already-completed patient is a well-formed thing to ask, and the answer is "no, because
        // of how this row stands right now".
        throw new ConflictException(body);
    }
  }

  /** The whole screen in one request. The day is resolved in the tenant's zone (Q12). */
  @Get("queue/today")
  @RequirePermission("appointments.read")
  async today(@Req() request: AuthenticatedRequest, @Query() query: QueueTodayQueryDto) {
    return describeQueueForDate(this.caller(request), {
      date: query.date,
      now: new Date(),
      ...(query.doctorId === undefined ? {} : { doctorId: query.doctorId }),
    });
  }

  /** `ARRIVE` + `MARK_WAITING`, one transaction (Q6). */
  @Patch("queue/:id/check-in")
  @RequirePermission("appointments.queueActions")
  async checkIn(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: QueueMoveDto,
  ) {
    const result = await checkIn(this.caller(request), {
      appointmentId: id,
      expectedStatus: body.expectedStatus,
      now: new Date(),
    });
    return result.ok ? result : this.refuse(result);
  }

  /**
   * `START_CONSULTATION`. No exclusivity check — Q7 allows a doctor two open at once.
   *
   * **Q40, ruled 2026-09-09: the appointment's own doctor's act.** `visits.write` is DOCTOR-only, so
   * reception is refused at the guard; `moveOwn` then refuses a colleague. Reception keeps check-in,
   * transfer and no-show, which are desk facts — who is here, who has gone, who is being handed on.
   * Which patient a doctor starts seeing is not one of those.
   */
  @Patch("queue/:id/start")
  @RequirePermission("visits.write")
  async start(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: QueueMoveDto,
  ) {
    const result = await startConsultation(this.caller(request), {
      appointmentId: id,
      expectedStatus: body.expectedStatus,
      now: new Date(),
    });
    return result.ok ? result : this.refuse(result);
  }

  /**
   * Q34. `visits.write` is DOCTOR-only, which is the guard the ruling asked for: reception can move
   * a patient around the board but cannot pause or resume a consultation they are not in.
   */
  @Patch("queue/:id/pause")
  @RequirePermission("visits.write")
  async pause(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: QueueMoveDto,
  ) {
    const result = await pauseConsultation(this.caller(request), {
      appointmentId: id,
      expectedStatus: body.expectedStatus,
      now: new Date(),
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
    return result.ok ? result : this.refuse(result);
  }

  @Patch("queue/:id/resume")
  @RequirePermission("visits.write")
  async resume(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: QueueMoveDto,
  ) {
    const result = await resumeConsultation(this.caller(request), {
      appointmentId: id,
      expectedStatus: body.expectedStatus,
      now: new Date(),
    });
    return result.ok ? result : this.refuse(result);
  }

  @Patch("queue/:id/complete")
  @RequirePermission("appointments.completeVisit")
  // Q40: and the appointment's own doctor, not any doctor — `moveOwn` inside.
  async complete(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: QueueMoveDto,
  ) {
    const result = await completeConsultation(this.caller(request), {
      appointmentId: id,
      expectedStatus: body.expectedStatus,
      now: new Date(),
    });
    return result.ok ? result : this.refuse(result);
  }

  /**
   * `MARK_NO_SHOW`. **A human action only** — nothing in this system marks a patient absent on its
   * own (Q8). The grace period is enforced inside `transition()`, measured from Q9's readiness
   * instant rather than from the appointment's scheduled start.
   */
  @Patch("queue/:id/no-show")
  @RequirePermission("appointments.queueActions")
  async noShow(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: QueueMoveDto,
  ) {
    const result = await markNoShow(this.caller(request), {
      appointmentId: id,
      expectedStatus: body.expectedStatus,
      now: new Date(),
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
    return result.ok ? result : this.refuse(result);
  }

  /**
   * The candidates a human is asked to confirm (Q8).
   *
   * This endpoint is a **read**, and that is a ruling rather than a property of the current
   * implementation. There is deliberately no companion endpoint that marks the whole list absent.
   */
  @Get("no-shows/pending")
  @RequirePermission("appointments.read")
  async pendingNoShows(
    @Req() request: AuthenticatedRequest,
    @Query() query: PendingNoShowsQueryDto,
  ) {
    const candidates = await pendingNoShowsForDate(this.caller(request), {
      date: query.date,
      now: new Date(),
    });
    return { candidates };
  }
}
