import type { MembershipRole, MembershipStatus } from "../../generated/prisma/enums.ts";
import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";

/**
 * Who works at this clinic — the listing half of item 2, ruled 2026-09-05.
 *
 * ## What this is, and what it deliberately is not
 *
 * This lists memberships that already exist. **It cannot create a user, and neither can anything
 * else in this API** — checked before it was written: `auth.controller.ts` has login, refresh,
 * logout, switch-tenant and me, and nothing anywhere writes a `users` row outside the seed and the
 * test fixtures. Every user in the product exists because the seed made one.
 *
 * The founder's ruling accepted that split on the costing: *"build the memberships listing now,
 * defer user creation. Half a day versus two weeks, and the listing is honest on its own."*
 *
 * The two weeks are not the endpoint — they are password setting or invitations, mail delivery,
 * token expiry, a first-login flow, and a decision about whether staff self-serve. None of that
 * exists, and half-building it would leave an invitation nobody can accept.
 *
 * ## What it unblocks
 *
 * `POST /doctors` takes a `membershipId` and there was no way to discover one, so the doctors
 * screen could not offer a create form and shipped without one. With this, an admin can pick from
 * the people who already have a login. It does not let them add a person who has none — that is
 * still the operator's job, and the doctors screen says so.
 *
 * ## `hasDoctorRecord` is here so the caller does not have to guess
 *
 * A membership already linked to a doctor cannot be linked again — `doctors.membership_id` is
 * unique, and `createDoctor` refuses with `ALREADY_A_DOCTOR`. Returning the flag lets a picker grey
 * those out instead of offering a choice that will be refused, which is the same reasoning the
 * services screen uses for a deactivated service.
 */

export interface MembershipSummary {
  membershipId: string;
  userId: string;
  fullName: string;
  /** From `users`. Nullable there, so nullable here — an account may have only a phone. */
  email: string | null;
  phoneE164: string;
  role: MembershipRole;
  status: MembershipStatus;
  /** True when this membership is already a doctor, so a picker can refuse it before the API does. */
  hasDoctorRecord: boolean;
}

export interface MembershipCaller {
  tenantId: string;
  actor: ActorContext;
}

/**
 * Every membership in this clinic, including inactive ones.
 *
 * Inactive are included for the same reason the doctors list includes deactivated doctors: a
 * management screen that hides them cannot reactivate them, and their absence reads as deletion.
 *
 * No paging. A clinic has staff, not users — the seeded fixtures have four and eight, and a Cairo
 * outpatient clinic with fifty would be remarkable. Adding a cursor here would be machinery for a
 * scale this product does not have; if that changes it is a small change, and pretending otherwise
 * now would cost more than it saves.
 */
export async function listMemberships(caller: MembershipCaller): Promise<MembershipSummary[]> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const rows = await tx.membership.findMany({
      select: {
        id: true,
        userId: true,
        role: true,
        status: true,
        user: { select: { fullName: true, email: true, phoneE164: true } },
        // A relation rather than a second query: one round trip, and the answer cannot drift from
        // the row it describes.
        doctor: { select: { id: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return rows.map((row) => ({
      membershipId: row.id,
      userId: row.userId,
      fullName: row.user.fullName,
      email: row.user.email,
      phoneE164: row.user.phoneE164,
      role: row.role,
      status: row.status,
      hasDoctorRecord: row.doctor !== null,
    }));
  });
}
