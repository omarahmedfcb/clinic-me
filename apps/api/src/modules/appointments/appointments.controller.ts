import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { PermissionGuard } from "../../common/permission.guard.ts";
import { RequirePermission } from "../../common/require-permission.decorator.ts";
import { refusal } from "../../common/refusals.ts";
import { TenantGuard } from "../../common/tenant.guard.ts";
import {
  AvailabilityQueryDto,
  CancelAppointmentDto,
  CreateAppointmentDto,
  DayViewQueryDto,
  DayBookingsQueryDto,
  MonthViewQueryDto,
  WeekViewQueryDto,
  RescheduleAppointmentDto,
} from "./appointments.dto.ts";
import {
  bookAppointment,
  changeAppointmentStatus,
  describeDoctorDay,
  describeDoctorWeek,
  findAvailableSlots,
  rescheduleAppointment,
  type CallerContext,
} from "./appointments.service.ts";
import { describeMonth, listDayBookings } from "./month-book.ts";

/**
 * The HTTP face of the appointments service. **Mapping only.**
 *
 * No business logic lives here, because the AI tool layer (ARCHITECTURE.md §12) calls the service
 * directly and would not see it. Every method does three things: build a `CallerContext` from the
 * validated token, call one service function, and translate its result into a status code.
 *
 * ## The status codes, and why `SLOT_TAKEN` is 409 rather than 500
 *
 * Losing the race for a slot is the design working. The engine offers, the exclusion constraint
 * decides, and someone else may book in between — so a `23P01` arriving thirty seconds after a
 * slot was offered is an ordinary outcome that the caller can act on by asking for availability
 * again. A 500 would say the server is broken; 409 says the world moved.
 *
 * ## No ownership checks
 *
 * A tenant-scoped lookup returning `NOT_FOUND` becomes 404, never 403 — the convention from
 * PHASE-1 §2b. Writing an ownership check would mean first reading a row the caller is not
 * entitled to see, and its 403 would confirm the record exists.
 */
@Controller()
@UseGuards(AuthGuard, TenantGuard, PermissionGuard)
export class AppointmentsController {
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
   * `find_available_slots()` over HTTP.
   *
   * The channel is **derived from the caller's role, not accepted from the request.** A staff
   * lead time of zero is the right answer for a receptionist booking a walk-in for right now, and
   * the wrong one for a remote self-service channel (Q22) — so letting a caller name its own
   * channel would let the strictest limit be opted out of by the party it exists to limit.
   */
  /**
   * **Deliberately NOT `own`-scoped, unlike the day view, the week grid and the queue.** Flagged for
   * ruling rather than decided here (`PHASE-3.md` §9).
   *
   * Those three return a colleague's *patients*. This returns free time and nothing else — no
   * patient, no appointment, no reason for a gap. Pinning it to the caller would make one real
   * clinic situation unrepresentable: a doctor referring a patient to a colleague has to see when
   * that colleague is free in order to book it, and `POST /appointments` takes no `doctorId` at all
   * (Q24 puts it inside the signed slot token), so availability is the only place that lookup can
   * happen.
   *
   * The line drawn: **free/busy is shared, who is in the chair is not.**
   */
  @Get("availability")
  @RequirePermission("appointments.read")
  async availability(@Req() request: AuthenticatedRequest, @Query() query: AvailabilityQueryDto) {
    const result = await findAvailableSlots(this.caller(request), {
      doctorId: query.doctorId,
      serviceId: query.serviceId,
      date: query.date,
      channel: "STAFF",
      now: new Date(),
    });

    if (!result.ok) {
      const refused = refusal(result.code, result.params);
      if (result.code === "OUTSIDE_HORIZON") throw new BadRequestException(refused);
      throw new NotFoundException(refused);
    }
    return { slots: result.slots };
  }

  @Get("schedule/day")
  @RequirePermission("appointments.read")
  async day(@Req() request: AuthenticatedRequest, @Query() query: DayViewQueryDto) {
    const description = await describeDoctorDay(this.caller(request), query.doctorId, query.date);
    if (description === null) throw new NotFoundException(refusal("NOT_FOUND", { resource: "doctor" }));
    return description;
  }

  /**
   * The weekly grid. A range rather than seven day requests — see `describeDoctorWeek` for the
   * measured cost and, more importantly, for why seven snapshots of one week can disagree.
   */
  @Get("schedule/range")
  @RequirePermission("appointments.read")
  async range(@Req() request: AuthenticatedRequest, @Query() query: WeekViewQueryDto) {
    const result = await describeDoctorWeek(this.caller(request), query.doctorId, query.from, query.to);
    if (result.ok) return { days: result.days };
    const refused = refusal(result.code, result.params);
    if (result.code === "RANGE_TOO_LONG") throw new BadRequestException(refused);
    throw new NotFoundException(refused);
  }

  /**
   * «المواعيد» — the month book. Counts per day per doctor, and nothing more.
   *
   * `appointments.read`, which every staff role holds: this is the board, and a link is gated by
   * what you go there to see. A doctor is pinned to their own days by `resolveReadableDoctorId`,
   * and the payload says `readOnly` so the screen offers neither booking nor moving to them.
   */
  @Get("schedule/month")
  @RequirePermission("appointments.read")
  async month(@Req() request: AuthenticatedRequest, @Query() query: MonthViewQueryDto) {
    const result = await describeMonth(
      this.caller(request),
      { month: query.month, ...(query.doctorId === undefined ? {} : { doctorId: query.doctorId }) },
      new Date(),
    );
    if (result.ok) return result.value;
    throw new NotFoundException(refusal(result.code, result.params));
  }

  /** The panel a day on the book opens: that day's bookings, with names. */
  @Get("schedule/day/bookings")
  @RequirePermission("appointments.read")
  async dayBookings(@Req() request: AuthenticatedRequest, @Query() query: DayBookingsQueryDto) {
    const result = await listDayBookings(this.caller(request), {
      date: query.date,
      ...(query.doctorId === undefined ? {} : { doctorId: query.doctorId }),
    });
    if (result.ok) return { bookings: result.value };
    throw new NotFoundException(refusal(result.code, result.params));
  }

  @Post("appointments")
  @RequirePermission("appointments.write")
  async create(@Req() request: AuthenticatedRequest, @Body() body: CreateAppointmentDto) {
    const result = await bookAppointment(this.caller(request), {
      slotToken: body.slotToken,
      patientId: body.patientId,
      source: body.source,
      complaintSummary: body.complaintSummary ?? null,
      bookingNotes: body.bookingNotes ?? null,
      now: new Date(),
    });

    if (result.ok) return result;

    const refused = refusal(result.code, result.params);
    switch (result.code) {
      case "SLOT_TAKEN":
      // 409 for both, and the same 409 on purpose. The two refusals differ in what they claim, not
      // in what the caller should do: SLOT_TAKEN says the world moved on, CONTENDED says we could
      // not get a turn, and either way the next step is to ask for availability again. A 5xx for
      // CONTENDED would say the server is broken -- which is precisely the false sentence this
      // whole change removes.
      case "CONTENDED":
        throw new ConflictException(refused);
      case "NOT_FOUND":
        // 404, never 403: a cross-tenant id must not be confirmed to exist (CLAUDE.md). The
        // resource -- patient or service -- is in `params` rather than in two codes.
        throw new NotFoundException(refused);
      case "PAST_SLOT":
        // 422, not 400: the request is well formed and was offered once. What is wrong is the world
        // -- that time has passed -- so "correct your input" would be the wrong sentence.
        throw new UnprocessableEntityException(refused);
      default:
        // INVALID_TOKEN and EXPIRED_TOKEN. Both are 400: the request is not something this server
        // ever offered, and repeating it unchanged will not help.
        throw new BadRequestException(refused);
    }
  }

  @Patch("appointments/:id/reschedule")
  @RequirePermission("appointments.write")
  async reschedule(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: RescheduleAppointmentDto,
  ) {
    const result = await rescheduleAppointment(this.caller(request), id, body.slotToken, new Date());
    if (result.ok) return result;

    const refused = refusal(result.code, result.params);
    switch (result.code) {
      case "SLOT_TAKEN":
      // The same 409 for both, for the reason given on `create`.
      case "CONTENDED":
        throw new ConflictException(refused);
      case "NOT_FOUND":
        throw new NotFoundException(refused);
      case "ILLEGAL_TRANSITION":
        // A conflict with the record's current state, not a malformed request.
        throw new ConflictException(refused);
      default:
        throw new BadRequestException(refused);
    }
  }

  @Patch("appointments/:id/cancel")
  @RequirePermission("appointments.write")
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: CancelAppointmentDto,
  ) {
    const result = await changeAppointmentStatus(this.caller(request), id, "CANCEL", {
      reason: body.reason,
      now: new Date(),
    });

    if (result.ok) return result;
    const refused = refusal(result.code, result.params);
    if (result.code === "NOT_FOUND") throw new NotFoundException(refused);
    // An illegal transition is a conflict with the record's current state, not a malformed
    // request: cancelling an already-completed appointment is a well-formed thing to ask.
    throw new ConflictException(refused);
  }

  @Patch("appointments/:id/confirm")
  @RequirePermission("appointments.write")
  async confirm(@Req() request: AuthenticatedRequest, @Param("id", ParseUUIDPipe) id: string) {
    const result = await changeAppointmentStatus(this.caller(request), id, "CONFIRM", {
      now: new Date(),
    });

    if (result.ok) return result;
    const refused = refusal(result.code, result.params);
    if (result.code === "NOT_FOUND") throw new NotFoundException(refused);
    throw new ConflictException(refused);
  }
}
