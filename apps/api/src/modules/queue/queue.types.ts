import type { AppointmentStatus } from "../../generated/prisma/client.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import type { QueueOrdering } from "./domain/ordering.ts";

/**
 * The queue's contracts — the shapes callers depend on, kept apart from the code that fulfils them.
 *
 * These are imported by `queue.moves.ts`, `queue.queries.ts` and, from checkpoint 4, the
 * controller and its DTOs. They live here so that adding an endpoint does not mean importing the
 * transaction machinery to get at a type.
 */

export type QueueRefusalReason =
  | "NOT_FOUND"
  // Q34: pausing is the doctor's own act about their own consultation, never a colleague's.
  | "NOT_PERMITTED"
  | "QUEUE_MOVED_ON"
  | "ILLEGAL_TRANSITION"
  | "TERMINAL_STATUS"
  | "GRACE_PERIOD_NOT_ELAPSED"
  | "REASON_REQUIRED"
  | "MISSING_CONTEXT";

export interface QueueMoveInput {
  appointmentId: string;
  /** Compare-and-set (Q2). The status the caller's screen was showing. */
  expectedStatus: AppointmentStatus;
  now: Date;
  /** Required for CANCEL; ignored otherwise. */
  reason?: string;
}

export type QueueMoveResult =
  | { ok: true; appointmentId: string; status: AppointmentStatus }
  | {
      ok: false;
      code: QueueRefusalReason;
      params: RefusalParams;
      /**
       * Present on QUEUE_MOVED_ON. **Kept beside `params` rather than folded into it**: `movedBy`
       * is a user id, which is data for the caller to resolve into a name and never a value the
       * client substitutes into a sentence. `params` is what the Arabic renders from; these two are
       * what the screen acts on.
       */
      currentStatus?: AppointmentStatus;
      movedBy?: string | null;
    };

/**
 * What the desk needs to decide about money, and deliberately nothing more. `PHASE-3.md` Q18.
 *
 * The founder's ruling: *"Keep it minimal on the queue row: insurer name and covered/not-covered.
 * Not the policy number, not the validity dates — those live on the profile. Enough to know whether
 * to ask for money."*
 *
 * **Three states, because `LAPSED` and `NONE` are different conversations.** "Your cover ended last
 * month" and "you have no insurance with us" lead reception to say completely different things to
 * the person in front of them, and collapsing them into one not-covered flag would delete that
 * distinction at exactly the moment it is needed. This is the same reason `policy-window.ts`
 * refuses to derive "expired" from "not in force".
 *
 * A patient holding both a live policy and a lapsed one is `COVERED`: the live one decides.
 */
export type QueueCoverage =
  | { standing: "COVERED"; insurerName: string }
  | { standing: "LAPSED"; insurerName: string }
  | { standing: "NONE" };

export interface QueueEntry {
  appointmentId: string;
  patientId: string;
  patientName: string | null;
  /**
   * Resolved in the same query as the rest of the queue — **never a per-row lookup.** The board
   * polls every five seconds (Q1), so one request per row would multiply the whole screen's cost by
   * the number of patients waiting, forever, for one label.
   */
  coverage: QueueCoverage;
  doctorId: string;
  serviceId: string;
  status: AppointmentStatus;
  scheduledStart: Date;
  scheduledEnd: Date;
  arrivedAt: Date | null;
  waitingStartedAt: Date | null;
  consultationStartedAt: Date | null;
  /** Milliseconds since arrival, or null if not yet arrived. Computed against the passed `now`. */
  waitedMs: number | null;
  isWalkIn: boolean;
  /**
   * DRAFT while the doctor is writing, COMPLETED once finished, null when no visit exists yet — Q14.
   *
   * The status of the visit belonging to **the appointment's own doctor**, and nothing else. Adding
   * a second visit field here is not a small change: `PHASE-4.md` Q14 draws the line at authorship
   * — a field may be added only if its value can be computed without reading a clinician-authored
   * column — and `queue-dto-allow-list.spec.ts` fails the build rather than letting one through.
   */
  visitStatus: "DRAFT" | "COMPLETED" | null;
}

export interface QueueQuery {
  /** The clinic-local day, `YYYY-MM-DD`. */
  date: string;
  /** Bounds of that day as instants, resolved by the caller in the tenant's zone (Q12). */
  dayStart: Date;
  dayEnd: Date;
  now: Date;
  /** Restricts to one doctor. A doctor viewing their own queue passes their own id. */
  doctorId?: string;
  ordering?: QueueOrdering;
}

export interface NoShowCandidate {
  appointmentId: string;
  patientId: string;
  patientName: string | null;
  doctorId: string;
  scheduledStart: Date;
  /** The instant from which a human may mark this absent — Q9's readiness plus grace. */
  eligibleSince: Date;
}

/** Statuses that put a patient on the queue. Terminal ones have left it. */
export const ON_QUEUE: readonly AppointmentStatus[] = [
  "BOOKED",
  "CONFIRMED",
  "ARRIVED",
  "WAITING",
  "IN_CONSULTATION",
  // Q34: a paused patient has not left, and the board is how reception knows why they are neither
  // waiting nor finished.
  "PAUSED",
];
