import type { CurrentUser } from "./session.tsx";

/**
 * Which doctor a screen is allowed to show, for screens that are shared between reception and a
 * doctor.
 *
 * ## Why a doctor gets no picker at all
 *
 * A doctor account **is** one doctor. Offering it a list of colleagues contradicts the `own`
 * permission level the rest of the system is built on: the day view and the schedule editor both
 * rendered a full clinic-wide `<select>` regardless of role, so a doctor could page through every
 * colleague's day. Reception genuinely needs that control — they work the room, not a doctor — so
 * the screen is shared and only the control is conditional.
 *
 * ## This hides a control. It is NOT a boundary, and the two screens differ
 *
 * Said precisely, because "the server is the real guard" is only half true here and a half-true
 * security claim is the kind this project keeps getting caught by:
 *
 * - **Schedules — enforced.** `doctorSchedules.manage` is `OWN` for `DOCTOR`, and
 *   `schedules.service.ts:107` narrows on it: a colleague's `doctorId` resolves to `null` and comes
 *   back 404. Hiding the picker matches what the API already refuses.
 * - **The day view — NOT enforced.** `/appointments/schedule/day` requires `appointments.write`,
 *   which `common/permissions.ts:73` grants `DOCTOR: FULL` *deliberately*, and
 *   `describeDoctorDay()` narrows by tenant only. A doctor who edits the query string still gets a
 *   colleague's day, 200. `GET /doctors` likewise returns the whole clinic list to anyone who can
 *   book, which its own comment states as intentional.
 *
 * So on the day view this is a convenience — it stops a doctor *stumbling* into a colleague's day,
 * which was the reported complaint — and nothing more. Whether the API should also narrow there is
 * a permission-matrix decision, not something to smuggle in behind a hidden `<select>`; it is
 * flagged for the founder rather than answered here.
 *
 * ## Why `membershipId` and not the user id
 *
 * `doctors.membership_id` is `@unique` and is the only link between a login and a doctor row. The
 * same human can hold memberships in two clinics (the seed has one), so the user id does not
 * identify a doctor — the membership does, and it is already on both `CurrentUser` and
 * `DoctorSummary`, which is why this needs no endpoint change.
 */
export const DOCTOR_ROLE = "DOCTOR";

export function isDoctorRole(me: CurrentUser): boolean {
  return me.role === DOCTOR_ROLE;
}

/**
 * The doctor row belonging to this login, or `null` when there is none.
 *
 * `null` is a real case, not a defensive branch: a `DOCTOR` membership whose `doctors` row was
 * archived still logs in. Callers must render an empty state rather than silently falling back to
 * the first doctor in the list, which is how a doctor would end up looking at a colleague's day.
 */
export function ownDoctorId<T extends { id: string; membershipId: string }>(
  me: CurrentUser,
  doctors: readonly T[],
): string | null {
  return doctors.find((d) => d.membershipId === me.membershipId)?.id ?? null;
}
