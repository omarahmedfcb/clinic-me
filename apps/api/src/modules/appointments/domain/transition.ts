import type { RefusalParams } from "../../../common/refusals.ts";

/**
 * The appointment state machine — ARCHITECTURE.md §9, as a pure total function.
 *
 * `transition(current, event, context) -> next | Refusal`. It decides; it never writes. The caller
 * persists the new status and the `appointment_events` row, inside the same transaction.
 *
 * ## Why a refusal is a value, not an exception
 *
 * The same reasoning as `patients.service.ts`: this is called by an HTTP controller *and* by the
 * AI tool layer (ARCHITECTURE.md §12), and the agent has no HTTP in it to catch a framework error
 * with. A refusal carries a machine-readable `reason` so the controller can map it to a status
 * code and the agent can turn it into a sentence, from the same value.
 *
 * ## Why the grace period lives in here
 *
 * §9 makes `no_show` reachable "only after `scheduled_start + grace_period`". That is a rule about
 * whether the transition is *legal*, so it belongs with the other legality rules rather than in a
 * caller that also has to remember it. "When can this become NO_SHOW" is then answerable by
 * reading one function. The period is a parameter (from `tenants.no_show_grace_minutes`) and `now`
 * is a parameter, for the same reason they are parameters everywhere else in `domain/`.
 *
 * ## Written whole, exposed in part
 *
 * The queue transitions belong to Phase 3 and `NO_SHOW` needs the nightly job, but the machine is
 * implemented and tested across the complete matrix now, because it is pure and cheap and a
 * half-written state machine is worse than none — it looks total. Phase 2's endpoints reach only
 * CONFIRM and CANCEL.
 */

export type AppointmentStatus =
  | "BOOKED"
  | "CONFIRMED"
  | "ARRIVED"
  | "WAITING"
  | "IN_CONSULTATION"
  | "PAUSED"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW";

export type AppointmentEvent =
  | "CONFIRM"
  | "ARRIVE"
  | "MARK_WAITING"
  | "START_CONSULTATION"
  | "PAUSE"
  | "RESUME"
  | "COMPLETE"
  | "CANCEL"
  | "MARK_NO_SHOW";

export interface TransitionContext {
  /** Required for CANCEL. §9: "Requires a reason." */
  reason?: string | null;
  /** Instant the transition is being attempted at. Never read from the clock. */
  now?: Date;
  scheduledStart?: Date;
  /** From `tenants.no_show_grace_minutes`. §9's "clinic-configurable, default 30 min". */
  noShowGraceMinutes?: number;
  /**
   * The instant the grace period runs from, when it is not the appointment's own start.
   *
   * `PHASE-3.md` Q9: a patient is absent only once the clinic was *ready* for them, so the queue
   * passes the later of `scheduledStart` and that doctor's last consultation end. Optional and
   * defaulting to `scheduledStart`, so every existing caller behaves exactly as before.
   *
   * It is a named field rather than the caller quietly passing a readiness instant as
   * `scheduledStart`, which would have needed no code change at all and would have left the
   * parameter lying about what it holds.
   */
  graceReference?: Date;
}

export type TransitionRefusalReason =
  | "ILLEGAL_TRANSITION"
  | "TERMINAL_STATUS"
  | "REASON_REQUIRED"
  | "GRACE_PERIOD_NOT_ELAPSED"
  | "MISSING_CONTEXT";

export type TransitionResult =
  | { ok: true; next: AppointmentStatus }
  | { ok: false; code: TransitionRefusalReason; params: RefusalParams };

/** §9's terminal states. `COMPLETED` re-opening is an admin action writing a visit revision. */
const TERMINAL: ReadonlySet<AppointmentStatus> = new Set(["COMPLETED", "CANCELLED", "NO_SHOW"]);

/**
 * The legal edges, transcribed from §9's diagram as data rather than as nested conditionals —
 * the same treatment `common/permissions.ts` gives the §8 matrix, for the same reason.
 *
 * CANCEL is reachable from BOOKED, CONFIRMED, ARRIVED and WAITING — notably **not** from
 * IN_CONSULTATION, where the visit has already begun and the record is what matters.
 * MARK_NO_SHOW is reachable from BOOKED and CONFIRMED only: a patient who arrived cannot later
 * be marked absent.
 */
const EDGES: Readonly<Record<AppointmentEvent, ReadonlyArray<AppointmentStatus>>> = {
  CONFIRM: ["BOOKED"],
  ARRIVE: ["BOOKED", "CONFIRMED"],
  MARK_WAITING: ["ARRIVED"],
  START_CONSULTATION: ["WAITING"],
  // Q34. PAUSE and RESUME are a pair and nothing else reaches PAUSED, so a paused appointment can
  // only have got there from a consultation this doctor was in the middle of.
  PAUSE: ["IN_CONSULTATION"],
  RESUME: ["PAUSED"],
  // A paused visit can be ended without resuming first: the patient came back, the doctor read the
  // film and finished. Requiring RESUME before COMPLETE would be a click that records nothing.
  COMPLETE: ["IN_CONSULTATION", "PAUSED"],
  CANCEL: ["BOOKED", "CONFIRMED", "ARRIVED", "WAITING"],
  MARK_NO_SHOW: ["BOOKED", "CONFIRMED"],
};

/**
 * The statuses an event is legal from — the edge table read outwards, terminal states removed.
 *
 * Exported so a screen can **ask** which actions are legal instead of restating the rules in a
 * hardcoded list. The founder's instruction, 1 September 2026, after the detail panel offered
 * cancel on a COMPLETED appointment: *"drive it from the state machine, not from a hardcoded list
 * — the transition table already knows which moves are legal, so the panel should ask it."*
 *
 * Terminal statuses are subtracted here because `transition()` refuses them before it consults
 * `EDGES` at all. A caller reading `EDGES` directly would get an answer that disagrees with the
 * function by exactly the three cases that matter.
 */
export function legalSourcesFor(event: AppointmentEvent): ReadonlyArray<AppointmentStatus> {
  return EDGES[event].filter((status) => !TERMINAL.has(status));
}

/**
 * Whether an appointment at this status may be moved to a different slot.
 *
 * **Reschedule is not an event and has no row in `EDGES`** — §9 makes it a mutation of the times
 * rather than a status change, which is why `rescheduleAppointment()` never called `transition()`.
 * That is also how it came to have no status check at all: sitting outside the state machine put
 * it outside every guard the state machine provides. A COMPLETED appointment could be moved to a
 * future slot, where — COMPLETED being a status that still occupies time — it would silently block
 * a real booking.
 *
 * So the rule is stated here, beside the table it belongs next to, rather than left implicit in
 * the absence of a check. The set matches CANCEL's deliberately: both ask "has this visit already
 * happened or already begun?", and the answer is the same one. ARRIVED and WAITING are included
 * because "the doctor is running late, come back Tuesday" is an ordinary thing to do to a patient
 * standing at the desk.
 */
export function canReschedule(current: AppointmentStatus): boolean {
  return legalSourcesFor("CANCEL").includes(current);
}

const TARGET: Readonly<Record<AppointmentEvent, AppointmentStatus>> = {
  CONFIRM: "CONFIRMED",
  ARRIVE: "ARRIVED",
  MARK_WAITING: "WAITING",
  START_CONSULTATION: "IN_CONSULTATION",
  PAUSE: "PAUSED",
  RESUME: "IN_CONSULTATION",
  COMPLETE: "COMPLETED",
  CANCEL: "CANCELLED",
  MARK_NO_SHOW: "NO_SHOW",
};

export function transition(
  current: AppointmentStatus,
  event: AppointmentEvent,
  context: TransitionContext = {},
): TransitionResult {
  // Checked before the edge table so a terminal status gives a specific answer rather than the
  // generic one. "That appointment is already cancelled" is a different conversation from "you
  // cannot do that from here", and the agent has to say one of them to a patient.
  if (TERMINAL.has(current)) {
    return {
      ok: false,
      code: "TERMINAL_STATUS",
      params: { status: current },
    };
  }

  if (!EDGES[event].includes(current)) {
    return {
      ok: false,
      code: "ILLEGAL_TRANSITION",
      params: { event, status: current, legalFrom: [...EDGES[event]] },
    };
  }

  if (event === "CANCEL" && (context.reason ?? "").trim() === "") {
    return {
      ok: false,
      code: "REASON_REQUIRED",
      params: {},
    };
  }

  if (event === "MARK_NO_SHOW") {
    const { now, scheduledStart, noShowGraceMinutes } = context;
    if (now === undefined || scheduledStart === undefined || noShowGraceMinutes === undefined) {
      return {
        ok: false,
        // Developer-facing: a caller reached this without the facts the rule needs. The client
        // renders one generic apology for these three; the explanation belongs to whoever wrote
        // the caller, and it stays in this file's comments rather than going on the wire.
        code: "MISSING_CONTEXT",
        params: {},
      };
    }
    const reference = context.graceReference ?? scheduledStart;
    const eligibleAt = reference.getTime() + noShowGraceMinutes * 60_000;
    if (now.getTime() < eligibleAt) {
      return {
        ok: false,
        // `at` is the instant, `limit` the grace in minutes. The old sentence also named which
        // reference the grace ran from -- scheduled start, or the doctor becoming free -- and that
        // has no consequence for the reader: either way the answer is "not until then".
        code: "GRACE_PERIOD_NOT_ELAPSED",
        params: { at: new Date(eligibleAt).toISOString(), limit: noShowGraceMinutes },
      };
    }
  }

  return { ok: true, next: TARGET[event] };
}

/** Every status, for exhaustive tests. Kept beside the machine so it cannot fall out of step. */
export const ALL_STATUSES: ReadonlyArray<AppointmentStatus> = [
  "BOOKED",
  "CONFIRMED",
  "ARRIVED",
  "WAITING",
  "IN_CONSULTATION",
  "PAUSED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
];

/**
 * The statuses an appointment can be in and still be going to happen.
 *
 * Exported for the same reason `legalSourcesFor` is: so a caller asks the state machine rather than
 * restating its rules. The services screen needs "how many future appointments use this service"
 * before deactivating one (`PHASE-5-DESIGN.md` §2.3), and the honest answer excludes the ones that
 * are already cancelled, completed or marked absent — a warning that counts three cancellations as
 * three upcoming visits is worse than no warning, because it makes an admin hesitate over nothing.
 *
 * Derived by subtracting the terminal set rather than typed out, so a fourth terminal status added
 * to §9 leaves here without anyone having to remember this line exists.
 */
export const LIVE_STATUSES: ReadonlyArray<AppointmentStatus> = ALL_STATUSES.filter(
  (status) => !TERMINAL.has(status),
);

/** The other half, for screens that count history: completed, cancelled and marked absent. */
export const TERMINAL_STATUSES: ReadonlyArray<AppointmentStatus> = ALL_STATUSES.filter((status) =>
  TERMINAL.has(status),
);

export const ALL_EVENTS: ReadonlyArray<AppointmentEvent> = [
  "CONFIRM",
  "ARRIVE",
  "MARK_WAITING",
  "START_CONSULTATION",
  "PAUSE",
  "RESUME",
  "COMPLETE",
  "CANCEL",
  "MARK_NO_SHOW",
];
