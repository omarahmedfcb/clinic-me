/**
 * When an insurance policy is in force, and nothing else.
 *
 * Pure, per `CLAUDE.md`: no I/O, and **the day being asked about is always a parameter**. The
 * reason is `prisma/sql/21-patient-insurance.sql`'s central decision — there is no `is_active`
 * column and no job that writes one, because a status column flipped by a nightly sweep looks
 * exactly like expiry, passes every test written against it, and reports a lapsed policy as live
 * forever if the sweep is never written or dies quietly. Absence is the only symptom. So the
 * comparison is made on every read, here, against an instant the caller supplies.
 *
 * That is D24's argument for transfer grants applied to the second thing in this system that
 * expires. If you are here to add an expiry job, read D24 first.
 */

/** `YYYY-MM-DD`. Calendar dates, not instants — a policy runs from a date to a date. */
export type CalendarDay = string;

export interface PolicyWindow {
  validFrom: CalendarDay;
  /** `null` means open-ended, which is a real case and must read as neither expired nor unknown. */
  validTo: CalendarDay | null;
}

/**
 * Is this policy in force on `onDay`?
 *
 * Both bounds are **inclusive**. A policy valid to the 31st covers the 31st: that is how a human
 * reads a card, and an exclusive end would silently drop the last day of every policy in the
 * system — a defect that shows up as one patient turned away, not as a failing test.
 *
 * Compared as `YYYY-MM-DD` strings rather than `Date` objects. That is not a shortcut: these come
 * from Postgres `DATE` columns, which Prisma hands back as `Date` at UTC midnight, and comparing
 * those against a "now" that carries a time-of-day is how an off-by-one-day bug gets in. Fixed
 * width and zero-padded, so lexicographic order **is** chronological order.
 */
export function isInForce(policy: PolicyWindow, onDay: CalendarDay): boolean {
  if (onDay < policy.validFrom) return false;
  if (policy.validTo === null) return true;
  return onDay <= policy.validTo;
}

/**
 * Has this policy ended before `onDay`?
 *
 * Deliberately **not** `!isInForce(...)`. A policy that has not started yet is also not in force,
 * and calling that "expired" on reception's screen would be wrong in a way that matters: a policy
 * starting next Monday is a reason to book the patient for next Monday, and one that lapsed last
 * month is a conversation about paying today. The founder's ruling is that expired cover is shown
 * as history rather than hidden, precisely so reception does not read "no active policy" as "this
 * patient never had one" — which means the two cases have to be distinguishable here.
 */
export function hasLapsed(policy: PolicyWindow, onDay: CalendarDay): boolean {
  return policy.validTo !== null && policy.validTo < onDay;
}

/** Not yet started. The third state, named so a caller cannot collapse it into one of the other two. */
export function isFuture(policy: PolicyWindow, onDay: CalendarDay): boolean {
  return onDay < policy.validFrom;
}

export type PolicyStanding = "ACTIVE" | "LAPSED" | "FUTURE";

/**
 * The one function callers should use. Total over the three states, so adding a fourth is a
 * compile error at every call site rather than a silent fall-through to "expired".
 */
export function standingOf(policy: PolicyWindow, onDay: CalendarDay): PolicyStanding {
  if (isFuture(policy, onDay)) return "FUTURE";
  if (isInForce(policy, onDay)) return "ACTIVE";
  return "LAPSED";
}
