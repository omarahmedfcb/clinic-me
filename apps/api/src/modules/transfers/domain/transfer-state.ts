import type { AppointmentStatus, TransferStatus } from "../../../generated/prisma/enums.ts";
import type { RefusalParams } from "../../../common/refusals.ts";

/**
 * The patient-transfer request state machine, and the access window it produces.
 *
 * Pure, per `CLAUDE.md`: no I/O, and **the clock is always a parameter**. A function that decides
 * whether access has expired and reads `new Date()` itself cannot be tested at the boundary, which
 * is the one place it matters — and this project has already shipped one "deterministic" thing that
 * quietly read the clock (`SEED_REFERENCE_DATE`, `PHASE-1.md`).
 *
 * Design and reasoning: `SCHEMA-DECISIONS.md` **D24**, `PHASE-3.md` Q16/Q17/Q21.
 */

/** `PHASE-3.md` Q17. Thirty days is the founder's number and is the only unexamined one here. */
export const TRANSFER_ACCESS_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type TransferEvent = "ACCEPT" | "REJECT" | "LAPSE";

/**
 * The one refusal a settled request can give. `params.status` says which way it settled —
 * `ACCEPTED` or `REJECTED` by a person, `LAPSED` by the appointment ending underneath it.
 *
 * Ruled 2026-09-07: this was two codes until then, `NO_LONGER_OPEN` for the lapsed case. Both
 * already carried `status`, and both asked the reader for the same next action, so the second code
 * was a distinction the param was already making.
 */
export type TransferRefusal = "ALREADY_DECIDED";

export type TransferTransition =
  | { ok: true; next: TransferStatus }
  | { ok: false; code: TransferRefusal; params: RefusalParams };

/**
 * The appointment statuses that close an open request.
 *
 * This set is the entire content of `LAPSED`, which `SCHEMA-DECISIONS.md` D24 records as deliberate
 * rather than incidental — *"the patient left, and there's still a request waiting for an answer."*
 * Listed explicitly rather than derived as "not BOOKED and not CONFIRMED", so that adding a new
 * `AppointmentStatus` is a compile error here rather than a silent reclassification: a status this
 * file has never seen would otherwise be treated as terminal by a negation, and a request would
 * lapse for a reason nobody chose.
 */
export const APPOINTMENT_CLOSES_REQUEST: readonly AppointmentStatus[] = [
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
];

export function appointmentClosesRequest(status: AppointmentStatus): boolean {
  return APPOINTMENT_CLOSES_REQUEST.includes(status);
}

/**
 * One step of the request's life.
 *
 * Every non-`PENDING` state is terminal, `LAPSED` included. D24: a new occasion is a new request,
 * because re-opening would make the audit trail claim a decision was pending during a period in
 * which nobody could have answered it.
 */
export function transition(current: TransferStatus, event: TransferEvent): TransferTransition {
  if (current !== "PENDING") {
    return {
      ok: false,
      code: "ALREADY_DECIDED",
      // `status` carries which answer it already had, which is the half of the sentence a person
      // actually needs: accepted, rejected, or lapsed — not merely "already decided". Since the
      // 2026-09-07 merge this param is the *only* thing distinguishing the three, so a caller that
      // drops it turns three different sentences into one vague one.
      params: { status: current },
    };
  }

  switch (event) {
    case "ACCEPT":
      return { ok: true, next: "ACCEPTED" };
    case "REJECT":
      return { ok: true, next: "REJECTED" };
    case "LAPSE":
      return { ok: true, next: "LAPSED" };
  }
}

/**
 * When a grant accepted at `decidedAt` stops working.
 *
 * Derived, never stored. `SCHEMA-DECISIONS.md` D24 carries the reasoning and the warning for
 * whoever later proposes a nightly job: a status column flipped by a sweep looks exactly like
 * expiry, and grants access forever if the sweep is never written.
 */
export function accessExpiresAt(decidedAt: Date, windowDays: number = TRANSFER_ACCESS_WINDOW_DAYS): Date {
  return new Date(decidedAt.getTime() + windowDays * DAY_MS);
}

export interface GrantView {
  status: TransferStatus;
  decidedAt: Date | null;
  /** The status of the appointment the request was raised against. */
  appointmentStatus: AppointmentStatus;
}

/**
 * Whether this transfer currently grants the receiving doctor clinical access.
 *
 * Three conditions, and all three are checked on every read:
 *
 * 1. the request was `ACCEPTED`;
 * 2. it has a `decidedAt` — the database `CHECK` guarantees this for a decided row, and the guard
 *    stays because a `null` here would make the comparison `now < null`, which is `false` for the
 *    wrong reason and would be indistinguishable from a legitimately expired grant;
 * 3. `now` is before the computed deadline.
 *
 * The appointment's own status is deliberately **not** consulted. A grant outlives the visit that
 * produced it — that is the entire point of an access window — and tying it to the appointment
 * would make the window unreachable, since the appointment closes the same day.
 */
export function grantIsActive(
  grant: GrantView,
  now: Date,
  windowDays: number = TRANSFER_ACCESS_WINDOW_DAYS,
): boolean {
  if (grant.status !== "ACCEPTED") return false;
  if (grant.decidedAt === null) return false;
  return now.getTime() < accessExpiresAt(grant.decidedAt, windowDays).getTime();
}

/**
 * The status a request should be *read* as, regardless of what the row says.
 *
 * A request is written to `LAPSED` in the same transaction as the appointment's terminal
 * transition. This exists for the case where that write did not happen — a transition path added
 * later that forgets to close open requests. Reading a stale `PENDING` as open would put a request
 * on reception's screen for an appointment that ended days ago, and would let it still be accepted.
 *
 * Belt and braces on purpose: the write is what notifies reception, so it must still happen; this
 * only ensures a missed write cannot also produce a *wrong answer*.
 */
export function effectiveStatus(grant: GrantView): TransferStatus {
  if (grant.status === "PENDING" && appointmentClosesRequest(grant.appointmentStatus)) return "LAPSED";
  return grant.status;
}
