import type { AppointmentSource, AppointmentStatus, MembershipRole } from "../../generated/prisma/client.ts";
import { resolveReadableDoctorId } from "../../common/doctor-scope.ts";
import { injected } from "../../prisma/injected.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { withTenant, type ActorContext, type TransactionClient } from "../../prisma/with-tenant.ts";
import { DeadlockExhaustedError, retryOnDeadlock } from "../../prisma/deadlock-retry.ts";
import { describeDay, type DayDescription } from "./domain/describe-day.ts";
import { generateSlots } from "./domain/generate-slots.ts";
import {
  canReschedule,
  legalSourcesFor,
  transition,
  type AppointmentEvent,
  type TransitionRefusalReason,
} from "./domain/transition.ts";
import type { DayPlanInput, Slot } from "./domain/types.ts";
import { addDays, loadContext, loadDayInput, loadWeekInput } from "./appointments.fetch.ts";
import { recordNotification } from "../notifications/notifications.service.ts";
import { lapseOpenRequests } from "../transfers/transfers.service.ts";
import { creditAbandonedPrePayments } from "../billing/patient-credit.ts";
import { mintSlotToken, verifySlotToken, type SlotTokenResult } from "./slot-token.ts";
import { lockDoctorDay } from "./slot-day-lock.ts";

/**
 * Appointments: availability, booking, rescheduling, cancellation.
 *
 * **This is the interface, not a controller's helper.** ARCHITECTURE.md §12: the AI tool layer
 * "never touches the database — it calls the same service layer the HTTP controllers use", and
 * `find_available_slots()` and `create_appointment()` are named tools in that registry. The same
 * constraints as `patients.service.ts` therefore apply, for the same reasons:
 *
 * - **No NestJS HTTP types.** A `ConflictException` reaching the WhatsApp agent would be an HTTP
 *   concept arriving somewhere with no HTTP in it.
 * - **Failure is a value.** Every function returns a discriminated result. The controller maps it
 *   to a status code; the agent maps it to a sentence. Two callers, one answer.
 * - **The caller supplies its identity.** `CallerContext` is passed in, never read from
 *   request-scoped storage, because the agent has no request.
 *
 * ## Losing the race is expected behaviour, not an error path
 *
 * The engine offers a slot; `no_double_booking` is the truth. Between the two there is a real gap
 * in which someone else can book, and a `23P01` thirty seconds after a slot was offered is the
 * system working as designed. `bookAppointment` therefore treats it as an ordinary outcome —
 * `SLOT_TAKEN` — not as an exception to be logged and 500'd. Application-level "is it still
 * free?" checks are exactly what the constraint exists to replace: they race, and under
 * concurrency they lose silently.
 */

export interface CallerContext {
  tenantId: string;
  actor: ActorContext;
  /**
   * From the validated JWT, both of them, and for the same reason `tenantId` is: `own` cannot be
   * decided without knowing who is asking, and anything taken from the request body can be edited
   * by the party it constrains. See `common/doctor-scope.ts` for the rule these two feed.
   */
  role: MembershipRole;
  membershipId: string;
}

/** Which lead time applies. PHASE-2.md Q22: a human in the clinic, or a remote channel. */
export type BookingChannel = "STAFF" | "PATIENT";

const CHANNEL_OF: Record<AppointmentSource, BookingChannel> = {
  RECEPTION: "STAFF",
  DOCTOR: "STAFF",
  WALK_IN: "STAFF",
  WHATSAPP: "PATIENT",
  ONLINE: "PATIENT",
};

export interface AvailabilityQuery {
  doctorId: string;
  serviceId: string;
  date: string;
  channel: BookingChannel;
  now: Date;
}

export interface OfferedSlot {
  start: Date;
  end: Date;
  utcOffsetMinutes: number;
  /** Opaque. Booking uses the token's values, never the request's (Q24). */
  token: string;
}

export type AvailabilityResult =
  | { ok: true; slots: OfferedSlot[] }
  | { ok: false; code: "NOT_FOUND" | "OUTSIDE_HORIZON"; params: RefusalParams };

export type BookingResult =
  | { ok: true; appointmentId: string; start: Date; end: Date }
  | {
      ok: false;
      code:
        | "INVALID_TOKEN"
        | "EXPIRED_TOKEN"
        | "SLOT_TAKEN"
        // Every attempt was killed to break a deadlock. Deliberately NOT folded into SLOT_TAKEN:
        // the loser of a deadlock lost a coin toss, not a slot. See `prisma/deadlock-retry.ts`.
        | "CONTENDED"
        | "NOT_FOUND"
        // The slot has already happened. Separate from EXPIRED_TOKEN: that one says the *offer* went
        // stale and a fresh one would work, this one says the time itself is gone and none would.
        | "PAST_SLOT";
      params: RefusalParams;
    };

export type StatusChangeResult =
  | { ok: true; status: AppointmentStatus }
  /**
   * `ILLEGAL` is gone. It flattened every state-machine refusal into one code and threw the
   * specifics away; now that `transition()` returns a code of its own, the refusal is forwarded
   * whole — which is what `queue.moves.ts` already did with the same decision object.
   */
  | { ok: false; code: "NOT_FOUND" | TransitionRefusalReason; params: RefusalParams };

/** Postgres exclusion-constraint violation. The whole point of the design, not a failure. */
const EXCLUSION_VIOLATION = "23P01";
const DOUBLE_BOOKING_CONSTRAINT = "no_double_booking";

/**
 * Did this error come from `no_double_booking` refusing an overlap?
 *
 * **The shape below was measured, not assumed.** My first version checked `error.code === "23P01"`
 * and `error.meta.code`, which is what the Prisma docs suggest and what neither of them is here.
 * Prisma 7 with the `pg` adapter raises a `PrismaClientKnownRequestError` whose own `code` is
 * `P2039` and buries the Postgres code two levels down:
 *
 * ```
 * { code: "P2039",
 *   meta: { modelName: "Appointment",
 *           driverAdapterError: { cause: { code: "23P01", message: "conflicting key value
 *                                          violates exclusion constraint \"no_double_booking\"" } } } }
 * ```
 *
 * That mistake failed loudly — the concurrency test threw instead of returning `SLOT_TAKEN` — but
 * it is worth noting that it would have failed *silently in production*: every loser of a race
 * would have become a 500 while the suite was green, because nothing but a concurrency test ever
 * reaches this branch.
 *
 * **The constraint name is checked too, not just the SQLSTATE.** `23P01` means "some exclusion
 * constraint refused this row". Today there is exactly one on `appointments`, but a future one —
 * a room or an equipment booking, say — would also raise `23P01`, and reporting that to a patient
 * as "that time was just taken" would be a confident lie. Anything else is rethrown.
 */
function isDoubleBookingViolation(error: unknown): boolean {
  const cause = (
    error as { meta?: { driverAdapterError?: { cause?: { code?: unknown; message?: unknown } } } } | null
  )?.meta?.driverAdapterError?.cause;

  if (cause?.code !== EXCLUSION_VIOLATION) return false;
  return String(cause.message ?? "").includes(DOUBLE_BOOKING_CONSTRAINT);
}

/**
 * `find_available_slots()` — ARCHITECTURE.md §12's single source of availability.
 *
 * Returns tokens, not bare times, so that `bookAppointment` can refuse a slot that was never
 * offered. The horizon is enforced here rather than in the engine, which stays date-agnostic and
 * pure; exceeding it is a distinguishable result rather than an empty list, because "we don't
 * book that far ahead" is something the agent has to be able to say.
 */
export async function findAvailableSlots(
  caller: CallerContext,
  query: AvailabilityQuery,
): Promise<AvailabilityResult> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const context = await loadContext(tx, caller.tenantId, query.doctorId, query.serviceId);
    if (!context.ok) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: {
          resource: context.reason === "UNKNOWN_DOCTOR" ? ("doctor" as const) : ("service" as const),
        },
      };
    }

    const horizonEnd = addDays(query.now.toISOString().slice(0, 10), context.tenant.bookingHorizonDays);
    if (query.date > horizonEnd) {
      return {
        ok: false as const,
        code: "OUTSIDE_HORIZON" as const,
        params: { limit: context.tenant.bookingHorizonDays, until: horizonEnd },
      };
    }

    const dayInput = await loadDayInput(tx, query.doctorId, query.date, context.timezone);
    const leadMinutes =
      query.channel === "STAFF"
        ? context.tenant.bookingLeadMinutesStaff
        : context.tenant.bookingLeadMinutesPatient;

    const slots: Slot[] = generateSlots({
      ...dayInput,
      service: { durationMinutes: context.durationMinutes, bufferMinutes: context.bufferMinutes },
      granularityMinutes: context.tenant.slotGranularityMinutes,
      leadMinutes,
      now: query.now,
    });

    return {
      ok: true as const,
      slots: slots.map((slot) => ({
        start: slot.start,
        end: slot.end,
        utcOffsetMinutes: slot.utcOffsetMinutes,
        token: mintSlotToken(
          {
            tenantId: caller.tenantId,
            doctorId: slot.doctorId,
            serviceId: query.serviceId,
            startMs: slot.start.getTime(),
            endMs: slot.end.getTime(),
          },
          query.now,
        ),
      })),
    };
  });
}

/** The reception day view. Same computation as availability — see `describeDay`. */
export async function describeDoctorDay(
  caller: CallerContext,
  doctorId: string,
  date: string,
): Promise<DayDescription | null> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    // The guard permitted the request; this scopes it. A DOCTOR reads their own day or none.
    const scopedId = await resolveReadableDoctorId(tx, caller, doctorId);
    if (scopedId === null) return null;

    const doctor = await tx.doctor.findFirst({ where: { id: scopedId, isActive: true } });
    if (doctor === null) return null;

    // By id, for the reason spelled out in loadContext: nothing else scopes this table.
    const tenant = await tx.tenant.findUnique({
      where: { id: caller.tenantId },
      select: { timezone: true },
    });
    if (tenant === null) return null;
    const timezone = tenant.timezone;

    return describeDay(await loadDayInput(tx, scopedId, date, timezone));
  });
}

/** Longest range the week view may ask for. A month of boxes is already more than a screen. */
export const MAX_RANGE_DAYS = 31;

export type WeekResult =
  | { ok: true; days: (DayDescription & { date: string })[] }
  | { ok: false; code: "NOT_FOUND" | "RANGE_TOO_LONG"; params: RefusalParams };

/**
 * The weekly grid: `describeDay()` for each date in a range, over **one** fetch.
 *
 * Not seven requests, for two reasons and the second is the important one.
 *
 * The cost: measured on this machine, seven sequential `/schedule/day` calls take 551 ms against
 * 123 ms for one — but 439 ms of that seven-call figure is the harness's own HTTP overhead, so the
 * true server-side difference is roughly 110 ms, about 18 ms per extra day. Small on localhost;
 * seven round trips over a clinic's connection is not, and each one re-verifies a JWT, opens a
 * transaction with four `set_config` bindings, and re-reads the same templates, breaks and
 * exceptions that the previous six already read.
 *
 * The consistency: seven requests are seven separate snapshots. An appointment booked between the
 * third and the fourth leaves the week disagreeing with itself on screen — a bug that appears only
 * on a busy morning and cannot be reproduced afterwards. One transaction, one snapshot.
 *
 * It is emphatically **not** a second computation. Each day is `describeDay()`, the same function
 * the booking flow's availability is cut from.
 */
export async function describeDoctorWeek(
  caller: CallerContext,
  doctorId: string,
  from: string,
  to: string,
): Promise<WeekResult> {
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  if (!Number.isFinite(span) || span < 1 || span > MAX_RANGE_DAYS) {
    return {
      ok: false,
      code: "RANGE_TOO_LONG",
      params: { limit: MAX_RANGE_DAYS },
    };
  }

  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    // Same scoping as the day view -- a week is seven of them, and a reader that forgot would be
    // the obvious way back in.
    const scopedId = await resolveReadableDoctorId(tx, caller, doctorId);
    if (scopedId === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "doctor" } as const,
      };
    }

    const doctor = await tx.doctor.findFirst({ where: { id: scopedId, isActive: true } });
    if (doctor === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "doctor" } as const,
      };
    }

    const tenant = await tx.tenant.findUnique({
      where: { id: caller.tenantId },
      select: { timezone: true },
    });
    if (tenant === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "doctor" } as const,
      };
    }

    const inputFor = await loadWeekInput(tx, scopedId, from, to, tenant.timezone);

    const days: (DayDescription & { date: string })[] = [];
    for (let i = 0; i < span; i += 1) {
      const date = addDays(from, i);
      days.push({ ...describeDay(inputFor(date)), date });
    }
    return { ok: true as const, days };
  });
}

export interface BookingInput {
  slotToken: string;
  patientId: string;
  source: AppointmentSource;
  complaintSummary?: string | null;
  bookingNotes?: string | null;
  now: Date;
}

/**
 * Whether the slot a token names has already begun — asked of a valid token or an expired one.
 *
 * A forged or malformed token has no claims worth reading, so it is never past: those are answered
 * as `INVALID_TOKEN`, which is the true thing to say about them.
 */
function isPastSlot(verified: SlotTokenResult, now: Date): boolean {
  if (verified.ok) return verified.claims.startMs < now.getTime();
  return verified.failure === "EXPIRED" && verified.claims.startMs < now.getTime();
}

/**
 * `create_appointment()`.
 *
 * The slot's identity comes **entirely from the token**. Nothing in `BookingInput` names a time,
 * a doctor or a service, so there is no request field for a caller — human or model — to
 * disagree with the offer in.
 */
export async function bookAppointment(
  caller: CallerContext,
  input: BookingInput,
): Promise<BookingResult> {
  const verified = verifySlotToken(input.slotToken, caller.tenantId, input.now);

  // **The past is reported before the expiry.** Ruled 2026-09-13: when a slot's time has gone,
  // `PAST_SLOT` is the true sentence and `EXPIRED_TOKEN` is a lesser one — it invites the caller to
  // ask for a fresh offer, and no offer would help. An expired token still carries its claims (the
  // signature was checked first), so the time is knowable either way.
  if (isPastSlot(verified, input.now)) {
    return { ok: false, code: "PAST_SLOT", params: {} };
  }

  if (!verified.ok) {
    const expired = verified.failure === "EXPIRED";
    return {
      ok: false,
      code: expired ? "EXPIRED_TOKEN" : "INVALID_TOKEN",
      params: {},
    };
  }
  const { claims } = verified;

  try {
    // Retried only on `40P01`, and only because a deadlock abort is a guaranteed full rollback --
    // `prisma/deadlock-retry.ts` carries the argument, including why PHASE-2.md's "do not add a
    // retry" rule does not reach this error shape. `23P01` is never retried: it is an answer.
    return await retryOnDeadlock(() =>
      withTenant(caller.tenantId, caller.actor, async (tx) => {
        const patient = await tx.patient.findFirst({ where: { id: input.patientId } });
        if (patient === null) {
          return {
            ok: false as const,
            code: "NOT_FOUND" as const,
            params: { resource: "patient" } as const,
          };
        }

        // The quoted price is snapshotted here and never joined for afterwards (PHASE-4.md §5).
        // `services.price_minor` is a mutable row: read it later and every past appointment silently
        // reprices itself the first time an admin edits the catalogue.
        //
        // The read is scoped by the tenant extension, so a service belonging to another clinic
        // resolves to null. That cannot be reached with a valid token -- the token is HMAC-signed
        // and carries the tenant -- but the foreign key would not catch it if it ever were, because
        // a foreign key does not respect row-level security. Refusing here costs one query.
        const quotedService = await tx.service.findFirst({
          where: { id: claims.serviceId },
          select: { priceMinor: true },
        });
        if (quotedService === null) {
          return {
            ok: false as const,
            code: "NOT_FOUND" as const,
            params: { resource: "service" } as const,
          };
        }

        // Before the insert, never after: taken afterwards the index entry already exists and the
        // cycle is already possible. Serialises every writer of this doctor-day so the exclusion
        // constraint is reached one transaction at a time and cannot deadlock. `retryOnDeadlock`
        // above stays as the safety net for anything this does not cover.
        await lockDoctorDay(tx, {
          tenantId: caller.tenantId,
          doctorId: claims.doctorId,
          at: new Date(claims.startMs),
        });

        const created = await tx.appointment.create({
          data: injected({
            patientId: input.patientId,
            doctorId: claims.doctorId,
            serviceId: claims.serviceId,
            quotedPriceMinor: quotedService.priceMinor,
            scheduledStart: new Date(claims.startMs),
            scheduledEnd: new Date(claims.endMs),
            status: "BOOKED",
            source: input.source,
            complaintSummary: input.complaintSummary ?? null,
            bookingNotes: input.bookingNotes ?? null,
            createdBy: caller.actor.userId,
            updatedBy: caller.actor.userId,
          }),
        });

        await tx.appointmentEvent.create({
          data: injected({
            appointmentId: created.id,
            eventType: "CREATED",
            fromStatus: null,
            toStatus: "BOOKED",
            toScheduledStart: created.scheduledStart,
            actorUserId: caller.actor.userId,
          }),
        });

        // In this transaction, not after it: a booking that rolls back must not leave a
        // notification claiming it happened (PHASE-2.md §16).
        await recordNotification(tx, caller.actor.userId, {
          kind: "APPOINTMENT_BOOKED",
          appointmentId: created.id,
          patientId: input.patientId,
          source: input.source,
          // `input.now`, not the row's created_at. All three kinds must stamp occurredAt from the
          // same source or they sort against each other unpredictably -- and CLAUDE.md's rule is
          // that the instant is a parameter, never read from the clock, precisely so an ordering
          // like this is reproducible in a test.
          occurredAt: input.now,
          payload: {
            patientName: patient.fullNameAr,
            start: created.scheduledStart.toISOString(),
          },
        });

        return {
          ok: true as const,
          appointmentId: created.id,
          start: created.scheduledStart,
          end: created.scheduledEnd,
        };
      }),
    );
  } catch (error) {
    // Expected, not exceptional. Someone booked this slot between the offer and the insert; the
    // constraint is the arbiter and it said no. There is deliberately no pre-check above — an
    // application-level "is it free?" races, and losing that race silently is the bug the
    // exclusion constraint exists to prevent.
    if (isDoubleBookingViolation(error)) {
      return {
        ok: false,
        code: "SLOT_TAKEN",
        params: {},
      };
    }
    // Every attempt was killed to break a deadlock. Truthful rather than convenient: nothing here
    // establishes that the slot is gone, so it must not say so. The caller's next move is the same
    // either way -- ask for availability again -- but the sentence a receptionist reads is
    // different, and at the desk that is the half that matters.
    if (error instanceof DeadlockExhaustedError) {
      return {
        ok: false,
        code: "CONTENDED",
        params: {},
      };
    }
    throw error;
  }
}

/**
 * Move an appointment to a different slot.
 *
 * §9: **reschedule is not a status.** It mutates the times, increments `reschedule_count`, and
 * appends an `appointment_events` row carrying both the old and the new start — so the history is
 * never lost and the state machine never gains an edge it does not have.
 *
 * It takes a slot token for the same reason booking does, and it can lose the same race: moving
 * into a slot someone else has just taken is a `SLOT_TAKEN`, not a failure.
 */
export async function rescheduleAppointment(
  caller: CallerContext,
  appointmentId: string,
  slotToken: string,
  now: Date,
): Promise<BookingResult | { ok: false; code: "NOT_FOUND" | "ILLEGAL_TRANSITION"; params: RefusalParams }> {
  const verified = verifySlotToken(slotToken, caller.tenantId, now);

  // Before the expiry, as booking does — and it matters more here, because the appointment already
  // exists and a move backwards would rewrite when it happened.
  if (isPastSlot(verified, now)) {
    return { ok: false, code: "PAST_SLOT", params: {} };
  }

  if (!verified.ok) {
    const expired = verified.failure === "EXPIRED";
    return {
      ok: false,
      code: expired ? "EXPIRED_TOKEN" : "INVALID_TOKEN",
      params: {},
    };
  }
  const { claims } = verified;

  try {
    // Same constraint, same deadlock, same reasoning as booking: a reschedule writes
    // `scheduled_start` and is arbitrated by `no_double_booking` exactly as an insert is.
    return await retryOnDeadlock(() =>
      withTenant(caller.tenantId, caller.actor, async (tx) => {
        const existing = await tx.appointment.findFirst({ where: { id: appointmentId } });
        if (existing === null) {
          return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "appointment" } as const,
      };
        }

        // Reschedule is not an event, so `transition()` never saw it and this check did not exist:
        // a COMPLETED appointment could be moved to a future slot, and COMPLETED still occupies
        // time, so it would sit there blocking a real booking with no status ever looking wrong.
        // The rule lives beside the edge table (`canReschedule`), not here, so the screen can ask
        // the same question this does rather than restating the answer.
        if (!canReschedule(existing.status)) {
          return {
            ok: false as const,
            // ILLEGAL_TRANSITION rather than the old ILLEGAL, so a reschedule refused on status
            // reads the same as every other state-machine refusal, with the same params.
            code: "ILLEGAL_TRANSITION" as const,
            params: {
              status: existing.status,
              legalFrom: [...legalSourcesFor("CANCEL")],
            },
          };
        }

        // Reschedule rewrites `serviceId` from the new token, so it can move an appointment onto a
        // different service -- and therefore onto a different price. The quote has to be re-taken
        // with it: a quote left pointing at the service it was not taken from is worse than no quote,
        // because it reads as a recorded fact and is a stale one.
        //
        // This does mean a reschedule re-quotes at today's price even when the service is unchanged.
        // That is the intended reading rather than a side effect: a reschedule is a conversation at
        // the desk, and what the patient is told during it is the current price.
        const quotedService = await tx.service.findFirst({
          where: { id: claims.serviceId },
          select: { priceMinor: true },
        });
        if (quotedService === null) {
          return {
            ok: false as const,
            code: "NOT_FOUND" as const,
            params: { resource: "service" } as const,
          };
        }

        // A reschedule writes `scheduled_start` and is arbitrated by the same constraint, so it
        // must take the same lock. A writer that skips it re-opens the cycle for everyone: the
        // guarantee is "every writer of this doctor-day queues", and it holds only if that is true
        // of all of them.
        await lockDoctorDay(tx, {
          tenantId: caller.tenantId,
          doctorId: claims.doctorId,
          at: new Date(claims.startMs),
        });

        const updated = await tx.appointment.update({
          where: { id: appointmentId },
          data: {
            scheduledStart: new Date(claims.startMs),
            scheduledEnd: new Date(claims.endMs),
            doctorId: claims.doctorId,
            serviceId: claims.serviceId,
            quotedPriceMinor: quotedService.priceMinor,
            rescheduleCount: { increment: 1 },
            updatedBy: caller.actor.userId,
          },
        });

        await tx.appointmentEvent.create({
          data: injected({
            appointmentId,
            eventType: "RESCHEDULED",
            fromStatus: existing.status,
            toStatus: existing.status,
            fromScheduledStart: existing.scheduledStart,
            toScheduledStart: updated.scheduledStart,
            actorUserId: caller.actor.userId,
          }),
        });

        const patient = await tx.patient.findFirst({ where: { id: existing.patientId } });
        await recordNotification(tx, caller.actor.userId, {
          kind: "APPOINTMENT_RESCHEDULED",
          appointmentId,
          patientId: existing.patientId,
          source: existing.source,
          occurredAt: now,
          payload: {
            patientName: patient?.fullNameAr ?? null,
            from: existing.scheduledStart.toISOString(),
            start: updated.scheduledStart.toISOString(),
          },
        });

        return {
          ok: true as const,
          appointmentId,
          start: updated.scheduledStart,
          end: updated.scheduledEnd,
        };
      }),
    );
  } catch (error) {
    if (isDoubleBookingViolation(error)) {
      return {
        ok: false,
        // The same code as booking's. The two sentences differed only in which verb the caller
        // was in the middle of, which the screen already knows.
        code: "SLOT_TAKEN",
        params: {},
      };
    }
    // Every attempt was killed to break a deadlock. Truthful rather than convenient: nothing here
    // establishes that the slot is gone, so it must not say so. The caller's next move is the same
    // either way -- ask for availability again -- but the sentence a receptionist reads is
    // different, and at the desk that is the half that matters.
    if (error instanceof DeadlockExhaustedError) {
      return {
        ok: false,
        code: "CONTENDED",
        params: {},
      };
    }
    throw error;
  }
}

/**
 * Drive one appointment through the §9 state machine.
 *
 * The decision is `transition()`'s; this function only persists what it returns and appends the
 * `appointment_events` row. A cross-tenant id resolves to `null` and becomes `NOT_FOUND`, never a
 * 403 — the 404 convention, which holds here for the same reason it does in patients: by the time
 * this runs, RLS and the scoping extension have made another clinic's appointment
 * indistinguishable from one that never existed.
 */
export async function changeAppointmentStatus(
  caller: CallerContext,
  appointmentId: string,
  event: AppointmentEvent,
  options: { reason?: string | null; now: Date },
): Promise<StatusChangeResult> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const appointment = await tx.appointment.findFirst({ where: { id: appointmentId } });
    if (appointment === null) {
      return {
        ok: false as const,
        code: "NOT_FOUND" as const,
        params: { resource: "appointment" } as const,
      };
    }

    const tenant = await tx.tenant.findUnique({
      where: { id: caller.tenantId },
      select: { noShowGraceMinutes: true },
    });
    const decision = transition(appointment.status, event, {
      reason: options.reason,
      now: options.now,
      scheduledStart: appointment.scheduledStart,
      noShowGraceMinutes: tenant?.noShowGraceMinutes,
    });

    if (!decision.ok) {
      return { ok: false as const, code: decision.code, params: decision.params };
    }

    await tx.appointment.update({
      where: { id: appointmentId },
      data: {
        status: decision.next,
        updatedBy: caller.actor.userId,
        cancellationReason: event === "CANCEL" ? (options.reason ?? null) : appointment.cancellationReason,
      },
    });

    await tx.appointmentEvent.create({
      data: injected({
        appointmentId,
        eventType: event === "CANCEL" ? "CANCELLED" : "STATUS_CHANGED",
        fromStatus: appointment.status,
        toStatus: decision.next,
        reason: options.reason ?? null,
        actorUserId: caller.actor.userId,
      }),
    });

    // Only CANCEL. The queue transitions are excluded on purpose: reception is watching the queue
    // board when they happen, so a notification for something already on screen is noise by
    // construction (PHASE-2.md §16).
    if (event === "CANCEL") {
      const patient = await tx.patient.findFirst({ where: { id: appointment.patientId } });
      await recordNotification(tx, caller.actor.userId, {
        kind: "APPOINTMENT_CANCELLED",
        appointmentId,
        patientId: appointment.patientId,
        source: appointment.source,
        occurredAt: options.now,
        payload: {
          patientName: patient?.fullNameAr ?? null,
          start: appointment.scheduledStart.toISOString(),
          reason: options.reason ?? null,
        },
      });
    }

    // A cancellation closes any open transfer request on this appointment, in the same
    // transaction, and notifies. D24: the patient left and there is still a request waiting for an
    // answer -- which from the desk is indistinguishable from still-pending.
    await lapseOpenRequests(tx, caller.actor.userId, appointmentId, decision.next, options.now);

    // R-A: a cancelled appointment that was pre-paid owes the patient that money, and the credit
    // commits with the cancellation — the same reason the transfer above is closed here and not later.
    await creditAbandonedPrePayments(tx, caller.actor.userId, appointmentId, decision.next);

    return { ok: true as const, status: decision.next };
  });
}
