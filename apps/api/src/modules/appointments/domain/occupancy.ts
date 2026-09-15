import type { Interval } from "./interval.ts";
import type { OccupancyRow } from "./types.ts";

/**
 * What counts as "this time is taken" — PHASE-2.md Q15 and Q16.
 *
 * There are **two** predicates here, not one, and the difference is the reason this file exists
 * rather than the logic living inline in the engine.
 *
 * `constraintOccupies` mirrors the `no_double_booking` EXCLUDE predicate exactly. It answers a
 * database question: *may this row be inserted?* If it ever disagrees with the SQL, the engine
 * offers slots Postgres will reject, or hides slots Postgres would accept — silently, in both
 * directions. `slot-engine-occupancy.spec.ts` reads the live predicate out of `pg_constraint` and
 * compares, rather than comparing against a copy of the SQL pasted into a test.
 *
 * `engineOccupies` answers a product question: *should we offer this?* It differs on exactly one
 * case. An `allow_overlap` appointment is invisible to the constraint by design (D3), so the time
 * is technically insertable again — but the override was a deliberate act by an admin, with a
 * recorded authoriser and reason. Re-offering that time to the WhatsApp agent would double-book
 * by design. So the engine treats it as taken.
 *
 * Collapsing these two into one predicate was the original plan and was wrong. Keeping them
 * together in one file, with the divergence named, is what stops them drifting apart later.
 */

/** Statuses that free the time. Mirrors the constraint's `status NOT IN (...)` exactly. */
const RELEASING_STATUSES = new Set(["CANCELLED", "NO_SHOW"]);

/**
 * The database's view: `status NOT IN ('CANCELLED','NO_SHOW') AND allow_overlap = false`.
 *
 * Do not "simplify" this to match `engineOccupies`. It is a mirror of SQL, and its job is to be
 * checkable against that SQL.
 */
export function constraintOccupies(appointment: OccupancyRow): boolean {
  return !RELEASING_STATUSES.has(appointment.status) && !appointment.allowOverlap;
}

/**
 * The engine's view: everything the constraint blocks, **plus** authorised overlaps.
 *
 * Deliberately expressed in terms of `constraintOccupies` rather than restating the status list,
 * so a change to the statuses cannot update one predicate and forget the other.
 */
export function engineOccupies(appointment: OccupancyRow): boolean {
  return constraintOccupies(appointment) || appointment.allowOverlap;
}

/**
 * The instant range an appointment removes from availability, in epoch milliseconds.
 *
 * Widened by **that appointment's own** service buffer (PHASE-2.md Q20), not by the buffer of the
 * service being booked: turnaround belongs to the visit that is ending. Getting this backwards
 * would apply a procedure's 15-minute cleanup to the follow-up booked after it and not to the
 * procedure itself.
 *
 * The buffer widens only the occupied footprint. It never shortens a bookable slot, and it is not
 * required to fit inside the working window — a 15-minute service at 16:45 in a window closing at
 * 17:00 stays bookable, because the buffer merely separates it from a next patient who, there,
 * cannot exist.
 */
export function occupiedFootprint(appointment: OccupancyRow): Interval {
  return {
    start: appointment.scheduledStart.getTime(),
    end: appointment.scheduledEnd.getTime() + appointment.serviceBufferMinutes * 60_000,
  };
}
