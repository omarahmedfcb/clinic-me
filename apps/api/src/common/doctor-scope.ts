import type { MembershipRole } from "../generated/prisma/client.ts";
import type { TransactionClient } from "../prisma/with-tenant.ts";

/**
 * Which doctor a read is allowed to be about.
 *
 * ## Why this exists as one function rather than three checks
 *
 * `ARCHITECTURE.md` §8 gives a `DOCTOR` `own` on several capabilities, and `common/permissions.ts`
 * says plainly why a route-level guard cannot enforce that:
 *
 * > PermissionGuard only proves the role has *some* access to the capability — telling "own" apart
 * > from "full" against a *specific* resource needs the actual resource in hand, which a
 * > route-level guard checking a JWT claim never has.
 *
 * `PHASE-1.md` carried it forward as a standing requirement: **`own`-scoped routes ship with a test
 * that the query is scoped, not that the guard allowed the request.** The founder's framing, on the
 * day this landed: *the guard permits the request; the query has to scope it.*
 *
 * Until 2026-09-01 that was true of exactly one module. `schedules.service.ts` narrowed properly and
 * every other `doctorId` reader — the day view, the week grid, the queue — took the id straight from
 * the request under `appointments.write`, which is `DOCTOR: FULL`. Hiding the picker in the web app
 * changed nothing: a doctor who edited a query parameter still read a colleague's day, 200. **The
 * rule is written once here so that adding a fourth reader is a call to this function rather than a
 * fourth chance to forget**, which is the whole reason a scattered `if (role === "DOCTOR")` was not
 * the fix.
 *
 * ## The rule
 *
 * For a `DOCTOR`, the doctor is resolved from the validated membership and any `doctorId` in the
 * request is ignored — **the same rule as `tenantId`**, which `CLAUDE.md` takes from the JWT only.
 * For every other staff role the parameter stands, because reception, admins and owners work the
 * whole clinic.
 *
 * Two outcomes, and the difference is deliberate:
 *
 * - **Parameter omitted** → the doctor's own id is substituted. Nothing was asked for, so nothing is
 *   refused.
 * - **Parameter names a colleague** → `null`, which every caller turns into **404**. Not 403: a 403
 *   confirms the record exists, and this is the same reasoning as the cross-tenant 404 in
 *   `CLAUDE.md` and the `null` that `resolveWritableDoctor()` already returns in
 *   `schedules.service.ts`. `PHASE-3.md`'s Definition of Done asks for exactly this — "404, and
 *   *indistinguishable* from a nonexistent id".
 *
 * ## What this is not
 *
 * It is not an authorisation check on its own, and it is not a substitute for `@RequirePermission()`
 * on the route. It is the second half of a two-part answer whose first half is the guard: the guard
 * says whether this role may call this endpoint at all, and this says which rows the call is
 * permitted to be about.
 */
export interface DoctorScopeCaller {
  /** From the validated JWT. `own` cannot be decided without it. */
  role: MembershipRole;
  /** From the validated JWT. `doctors.membership_id` is `@unique` and is the only login→doctor link. */
  membershipId: string;
}

/** The role that is pinned to itself. A `DOCTOR` account is one doctor. */
const PINNED_ROLE: MembershipRole = "DOCTOR";

export function isPinnedToOwnDoctor(caller: DoctorScopeCaller): boolean {
  return caller.role === PINNED_ROLE;
}

/**
 * The doctor id this read may use, or `null` meaning "answer as though it does not exist".
 *
 * `null` has two causes and callers must not tell them apart: a colleague's id from a pinned role,
 * and a pinned role with no `doctors` row at all. The second is real rather than defensive — a
 * `DOCTOR` membership whose doctor row was archived still holds a valid token — and it must not fall
 * back to "the first doctor in the tenant", which is how a doctor ends up reading a colleague's day.
 *
 * Overloaded so the `undefined` only exists where the caller actually has an optional parameter: a
 * required `doctorId` in, a `string | null` out. The day view should not have to narrow away an
 * `undefined` that its own DTO makes impossible.
 */
export async function resolveReadableDoctorId(
  tx: TransactionClient,
  caller: DoctorScopeCaller,
  requestedDoctorId: string,
): Promise<string | null>;
export async function resolveReadableDoctorId(
  tx: TransactionClient,
  caller: DoctorScopeCaller,
  requestedDoctorId: string | undefined,
): Promise<string | null | undefined>;
export async function resolveReadableDoctorId(
  tx: TransactionClient,
  caller: DoctorScopeCaller,
  requestedDoctorId: string | undefined,
): Promise<string | null | undefined> {
  if (!isPinnedToOwnDoctor(caller)) return requestedDoctorId;

  const own = await tx.doctor.findFirst({
    where: { membershipId: caller.membershipId },
    select: { id: true },
  });
  if (own === null) return null;

  // Ignored, not compared-then-refused, when nothing was asked for. When a colleague *was* named,
  // the answer is "no such thing" rather than a silent substitution -- silently returning different
  // data than was asked for is how a caller comes to believe it read something it did not.
  if (requestedDoctorId === undefined) return own.id;
  return requestedDoctorId === own.id ? own.id : null;
}
