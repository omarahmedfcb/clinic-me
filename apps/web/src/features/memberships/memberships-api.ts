/**
 * Who works at this clinic — the client half of `apps/api/src/modules/memberships/`.
 *
 * Mirrors the API module rather than living inside `features/doctors/`, per CLAUDE.md's rule that
 * modules mirror between the two trees. It has one consumer today (the add-doctor picker) and that
 * is not a reason to file it under that consumer: the next screen to need "who works here" is the
 * users screen, and a list that lives inside `doctors/` would be moved on the day it grew a second
 * caller.
 *
 * ## There is no `createMembership` here, and there cannot be one
 *
 * Nothing in the API writes a `users` row outside the seed and the test fixtures — checked, not
 * assumed. The founder ruled on 2026-09-05 to ship the listing and defer user creation, on the
 * costing that the endpoint is not the work: password setting or invitations, mail delivery, token
 * expiry, a first-login flow and a decision about whether staff self-serve are. So this lists the
 * people who already have a login, and the add-doctor form says so on the screen rather than
 * offering a control that cannot work.
 */

export type MembershipRole = "OWNER" | "ADMIN" | "DOCTOR" | "RECEPTIONIST" | "AI_AGENT";

export interface Membership {
  membershipId: string;
  userId: string;
  fullName: string;
  /** From `users`, nullable there and nullable here — an account may have only a phone. */
  email: string | null;
  phoneE164: string;
  role: MembershipRole;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  /**
   * True when this membership already has a doctor record.
   *
   * `doctors.membership_id` is unique and `POST /doctors` refuses a second one, so the picker greys
   * these out instead of offering a choice the server will reject. The same reasoning the services
   * screen uses for a deactivated service: an option that is always refused is worse than no
   * option, because the refusal reads as a fault in the system rather than a rule of it.
   */
  hasDoctorRecord: boolean;
}

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Every membership in this clinic, including suspended and revoked ones.
 *
 * Under `users.manage`, which reception and doctors do not hold — so every caller must gate the
 * fetch on that capability rather than call it and handle a 403. A screen that asks for something
 * the matrix says it cannot read is the defect that took the owner's queue board down on
 * 2026-09-06, and it is cheaper not to ask.
 */
export async function loadMemberships(authFetch: AuthFetch): Promise<Membership[]> {
  const response = await authFetch("/api/memberships");
  if (!response.ok) throw new Error(`GET /memberships -> ${response.status}`);
  return (await response.json()) as Membership[];
}
