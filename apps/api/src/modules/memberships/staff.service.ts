// «المستخدمون» — who has an account in this clinic. Phase 5, PR 10.
// Accounts and access, never employment: nothing here records a shift worked or a salary paid.

import { randomBytes, randomUUID } from "node:crypto";
import type { MembershipRole } from "../../generated/prisma/enums.ts";
import type { RefusalParams } from "../../common/refusals.ts";
import { prisma } from "../../prisma/client.ts";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import { hashPassword } from "../auth/password.ts";
import { normalisePhone } from "../auth/phone.ts";
import { revokeAllForUser } from "../auth/refresh-tokens.ts";

export interface StaffCaller {
  tenantId: string;
  actor: ActorContext;
}

export type StaffRefusalReason =
  | "NOT_FOUND"
  | "ALREADY_A_MEMBER"
  | "INVALID_PHONE"
  | "LAST_ADMIN"
  | "SELF_SUSPEND"
  | "DUPLICATE_PHONE"
  | "NOT_EDITABLE_HERE"
  | "OWNER_ROLE_FIXED"
  | "SELF_ROLE_CHANGE";

export type StaffResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: StaffRefusalReason; params: RefusalParams };

/** The two roles this screen creates. A doctor's account is made by the Doctors tab, with a `Doctor` row. */
export const STAFF_ROLES = ["RECEPTIONIST", "ADMIN"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export interface StaffMember {
  membershipId: string;
  userId: string;
  fullName: string;
  phoneE164: string;
  role: MembershipRole;
  status: string;
  lastLoginAt: string | null;
  /** True while a temporary password is outstanding — the account cannot do anything else yet. */
  mustChangePassword: boolean;
  /**
   * Doctors are listed so the answer to "who has an account here" is complete, and are not editable
   * here: their record is a `Doctor` row the Doctors tab owns, and a second place to edit one is a
   * second place for its rules to be forgotten.
   */
  editableHere: boolean;
  /** Set for a doctor, so the screen can link across rather than duplicate the form. */
  doctorId: string | null;
  /** Whether a photo is stored. The bytes come from the route, never a URL — see photo-key.ts. */
  hasPhoto: boolean;
}

const ROW = {
  id: true,
  role: true,
  status: true,
  user: {
    select: {
      id: true,
      fullName: true,
      phoneE164: true,
      lastLoginAt: true,
      mustChangePassword: true,
      photoStorageKey: true,
    },
  },
  doctor: { select: { id: true } },
} as const;

type Row = {
  id: string;
  role: MembershipRole;
  status: string;
  user: {
    id: string;
    fullName: string;
    phoneE164: string;
    lastLoginAt: Date | null;
    mustChangePassword: boolean;
    photoStorageKey: string | null;
  };
  doctor: { id: string } | null;
};

const toMember = (row: Row): StaffMember => ({
  membershipId: row.id,
  userId: row.user.id,
  fullName: row.user.fullName,
  phoneE164: row.user.phoneE164,
  role: row.role,
  status: row.status,
  lastLoginAt: row.user.lastLoginAt?.toISOString() ?? null,
  mustChangePassword: row.user.mustChangePassword,
  editableHere: row.doctor === null,
  doctorId: row.doctor?.id ?? null,
  hasPhoto: row.user.photoStorageKey !== null,
});

/** Everyone with a membership here, suspended accounts included: the screen has to reactivate one. */
export async function listStaff(caller: StaffCaller): Promise<StaffMember[]> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const rows = await tx.membership.findMany({ select: ROW, orderBy: { createdAt: "asc" } });
    return rows.map((row) => toMember(row as Row));
  });
}

/**
 * A temporary password: 12 characters from an unambiguous alphabet, read aloud once and hashed.
 *
 * No `l`, `1`, `O` or `0`. An admin reads this over a desk to somebody who then types it, and a
 * character pair nobody can tell apart turns a password reset into a support call.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export function generateTemporaryPassword(): string {
  const bytes = randomBytes(12);
  // Rejection-free modulo bias is irrelevant here — the alphabet is 56 long and this is a
  // short-lived credential the holder must replace before doing anything at all.
  return [...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join("");
}

/**
 * Creates a staff account, or attaches an existing person to this clinic.
 *
 * **A person can already exist**: a doctor working at two clinics is the case the membership table
 * was built for, and the same is true of a receptionist moving between them. So a phone number that
 * is already a user is not an error — it becomes a second membership, with its own role and status.
 * What is refused is a second membership *in this clinic*, which is the "one role per clinic" rule.
 */
export async function createStaff(
  caller: StaffCaller,
  input: { fullName: string; phone: string; role: StaffRole },
  country: "EG" | "SA" | "AE",
): Promise<StaffResult<{ member: StaffMember; temporaryPassword: string }>> {
  const phoneE164 = normalisePhone(input.phone, country);
  if (phoneE164 === null) {
    return { ok: false, code: "INVALID_PHONE", params: {} };
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  // `users` is not tenant-scoped — it is a person, not a clinic's record of one — so the lookup and
  // the create go through the base client, and only the membership is written inside the tenant.
  const existing = await prisma.user.findFirst({ where: { phoneE164 }, select: { id: true } });

  if (existing !== null) {
    const clash = await withTenant(caller.tenantId, caller.actor, (tx) =>
      tx.membership.findFirst({ where: { userId: existing.id }, select: { id: true } }),
    );
    if (clash !== null) {
      return { ok: false, code: "ALREADY_A_MEMBER", params: { name: input.fullName } };
    }
  }

  const userId =
    existing?.id ??
    (
      await prisma.user.create({
        data: {
          id: randomUUID(),
          phoneE164,
          fullName: input.fullName,
          passwordHash,
          status: "ACTIVE",
          mustChangePassword: true,
        },
        select: { id: true },
      })
    ).id;

  // An existing person keeps their own password: issuing one for an account they already use would
  // lock them out of the clinic they are already working in.
  const member = await withTenant(caller.tenantId, caller.actor, async (tx) => {
    const membershipId = randomUUID();
    await tx.membership.create({
      data: injected({ id: membershipId, userId, role: input.role, status: "ACTIVE" }),
    });
    return tx.membership.findFirstOrThrow({ where: { id: membershipId }, select: ROW });
  });

  return {
    ok: true,
    value: {
      member: toMember(member as Row),
      // Shown once. For somebody who already had an account this is not their password, and the
      // screen says so rather than printing a credential that does not work.
      temporaryPassword: existing === null ? temporaryPassword : "",
    },
  };
}

/**
 * Edits a staff account: the name, the phone number, the role. Any subset.
 *
 * **A doctor is not editable here.** Their record is a `Doctor` row the Doctors tab owns, and a
 * second place to edit one is a second place for its rules to be forgotten — the screen links
 * across instead, which is what `editableHere` on the list is for.
 *
 * **The phone is the login, and it is the person's, not the clinic's.** `users` is not tenant-scoped,
 * so changing it here changes how that human signs in to every clinic they work at. That is correct —
 * it is one person with one number — and it is why a number already belonging to somebody else is
 * refused rather than merged: two people cannot share a login.
 */
export async function updateStaff(
  caller: StaffCaller,
  membershipId: string,
  input: { fullName?: string; phone?: string; role?: StaffRole },
  country: "EG" | "SA" | "AE",
): Promise<StaffResult<StaffMember>> {
  // Re-validated as E.164 against the clinic's country, exactly as creating an account is: a number
  // that was typed once correctly can be retyped wrongly.
  const phoneE164 = input.phone === undefined ? undefined : normalisePhone(input.phone, country);
  if (phoneE164 === null) return { ok: false, code: "INVALID_PHONE", params: {} };

  const row = await withTenant(caller.tenantId, caller.actor, (tx) =>
    tx.membership.findFirst({ where: { id: membershipId }, select: ROW }),
  );
  if (row === null) {
    return { ok: false, code: "NOT_FOUND", params: { resource: "membership" } };
  }
  if (row.doctor !== null) {
    return { ok: false, code: "NOT_EDITABLE_HERE", params: { name: row.user.fullName } };
  }

  // Platform-wide: `users.phone_e164` is unique across every clinic, so the clash may be with
  // somebody this caller cannot see. The sentence says the number is taken and nothing about whom.
  if (phoneE164 !== undefined && phoneE164 !== row.user.phoneE164) {
    const taken = await prisma.user.findFirst({
      where: { phoneE164, id: { not: row.user.id } },
      select: { id: true },
    });
    if (taken !== null) return { ok: false, code: "DUPLICATE_PHONE", params: {} };
  }

  const changesRole = input.role !== undefined && input.role !== row.role;

  // **Who owns a clinic is not a users-list decision.** This is the bug that demoted the owner: the
  // dialog offered two roles, OWNER was neither, and the save sent one of them.
  if (changesRole && row.role === "OWNER") {
    return { ok: false, code: "OWNER_ROLE_FIXED", params: {} };
  }

  // The founder's ruling, and the other half of self-suspension: a person who demotes themselves
  // loses the screen that would undo it.
  if (changesRole && row.user.id === caller.actor.userId) {
    return { ok: false, code: "SELF_ROLE_CHANGE", params: {} };
  }

  // The same rule suspension has, through the other door. The trigger refuses this too; the point
  // of checking here is that the screen gets a sentence instead of a failed write.
  const losesAdmin =
    input.role !== undefined &&
    (row.role === "OWNER" || row.role === "ADMIN") &&
    input.role !== "ADMIN" &&
    row.status === "ACTIVE";
  if (losesAdmin) {
    const others = await withTenant(caller.tenantId, caller.actor, (tx) =>
      tx.membership.count({
        where: { id: { not: membershipId }, status: "ACTIVE", role: { in: ["ADMIN", "OWNER"] } },
      }),
    );
    if (others === 0) return { ok: false, code: "LAST_ADMIN", params: {} };
  }

  if (input.fullName !== undefined || phoneE164 !== undefined) {
    // Through `withTenant`, which binds the actor `users_audit` requires. `users` is not
    // tenant-scoped, so the extension passes this through — the binding is why it goes this way.
    await withTenant(caller.tenantId, caller.actor, (tx) =>
      tx.user.update({
        where: { id: row.user.id },
        data: {
          ...(input.fullName === undefined ? {} : { fullName: input.fullName }),
          ...(phoneE164 === undefined ? {} : { phoneE164 }),
        },
      }),
    );
  }

  // **A changed phone number is a changed login.** Same reasoning as the role: the sessions that
  // exist were issued against the old identity, and the holder should sign in with the new one.
  if (phoneE164 !== undefined && phoneE164 !== row.user.phoneE164) {
    await revokeAllForUser(row.user.id, "phone changed");
  }

  const updated = await withTenant(caller.tenantId, caller.actor, async (tx) => {
    // The role goes through the tenant client, because a membership is the clinic's record. The
    // database refuses a change that would leave the clinic with no active administrator.
    if (changesRole && input.role !== undefined) {
      await tx.membership.update({ where: { id: membershipId }, data: { role: input.role } });
    }
    return tx.membership.findFirstOrThrow({ where: { id: membershipId }, select: ROW });
  });

  // **A changed role ends that person's sessions.** Their access token still carries the old role
  // until it expires, and `MembershipFreshnessInterceptor` is what turns the next request into a
  // 401 — but the refresh family has to go too, or the next refresh mints the old capabilities again.
  if (changesRole) await revokeAllForUser(row.user.id, "role changed");

  return { ok: true, value: toMember(updated as Row) };
}

/**
 * «بياناتي» — your own name and phone number, whatever your role. Ruled 2026-09-13.
 *
 * **The membership comes from the token, never from a path**, so there is nothing to scope: this
 * cannot reach another person's row. That is why it needs no `users.manage` — a receptionist
 * correcting the spelling of her own name has no authority over anybody else's account.
 *
 * **Not `updateStaff` with a different caller.** That one refuses a doctor outright, because the
 * Doctors tab owns a doctor's *record*; it does not own their name. And it takes a role, which this
 * deliberately cannot: nobody promotes themselves, and the screen does not offer it.
 */
export async function updateMyDetails(
  caller: StaffCaller,
  membershipId: string,
  input: { fullName?: string; phone?: string },
  country: "EG" | "SA" | "AE",
): Promise<StaffResult<StaffMember>> {
  const phoneE164 = input.phone === undefined ? undefined : normalisePhone(input.phone, country);
  if (phoneE164 === null) return { ok: false, code: "INVALID_PHONE", params: {} };

  const row = await withTenant(caller.tenantId, caller.actor, (tx) =>
    tx.membership.findFirst({ where: { id: membershipId }, select: ROW }),
  );
  if (row === null) {
    return { ok: false, code: "NOT_FOUND", params: { resource: "membership" } };
  }
  // The token said this membership; the token also said who the caller is. If those disagree the
  // claim is not about the caller, and "not found" is the answer a path cannot be probed with.
  if (row.user.id !== caller.actor.userId) {
    return { ok: false, code: "NOT_FOUND", params: { resource: "membership" } };
  }

  if (phoneE164 !== undefined && phoneE164 !== row.user.phoneE164) {
    const taken = await prisma.user.findFirst({
      where: { phoneE164, id: { not: row.user.id } },
      select: { id: true },
    });
    if (taken !== null) return { ok: false, code: "DUPLICATE_PHONE", params: {} };
  }

  if (input.fullName !== undefined || phoneE164 !== undefined) {
    await withTenant(caller.tenantId, caller.actor, (tx) =>
      tx.user.update({
        where: { id: row.user.id },
        data: {
          ...(input.fullName === undefined ? {} : { fullName: input.fullName }),
          ...(phoneE164 === undefined ? {} : { phoneE164 }),
        },
      }),
    );
  }

  // The phone is the login. Changing your own ends your own sessions, which is the honest
  // consequence rather than a surprise at the next refresh.
  if (phoneE164 !== undefined && phoneE164 !== row.user.phoneE164) {
    await revokeAllForUser(row.user.id, "phone changed");
  }

  const updated = await withTenant(caller.tenantId, caller.actor, (tx) =>
    tx.membership.findFirstOrThrow({ where: { id: membershipId }, select: ROW }),
  );
  return { ok: true, value: toMember(updated as Row) };
}

/**
 * Suspends or reactivates. **Never deletes** — `CLAUDE.md`, and a staff row is the actor on every
 * audit line that person ever wrote, so deleting one takes a foreign key with it.
 */
export async function setStaffStatus(
  caller: StaffCaller,
  membershipId: string,
  status: "ACTIVE" | "SUSPENDED",
): Promise<StaffResult<StaffMember>> {
  return withTenant(caller.tenantId, caller.actor, async (tx) => {
    const row = await tx.membership.findFirst({ where: { id: membershipId }, select: ROW });
    if (row === null) {
      return { ok: false as const, code: "NOT_FOUND" as const, params: { resource: "membership" as const } };
    }

    // **Nobody suspends themselves.** An admin who does it is locked out of the screen that would
    // undo it, and the database refuses this too — the trigger is what makes it true of a direct
    // UPDATE; this is what makes it a sentence rather than a 500.
    if (status === "SUSPENDED" && row.user.id === caller.actor.userId) {
      return { ok: false as const, code: "SELF_SUSPEND" as const, params: {} };
    }

    // **A clinic cannot suspend its way out of having an administrator.** The next person to need
    // an admin action would have nobody to ask and no screen to fix it from.
    if (status === "SUSPENDED" && (row.role === "ADMIN" || row.role === "OWNER")) {
      const others = await tx.membership.count({
        where: { id: { not: membershipId }, status: "ACTIVE", role: { in: ["ADMIN", "OWNER"] } },
      });
      if (others === 0) return { ok: false as const, code: "LAST_ADMIN" as const, params: {} };
    }

    await tx.membership.update({ where: { id: membershipId }, data: { status } });
    // Suspension takes effect now, not at the next login: the refresh family goes, and the
    // freshness interceptor turns the suspended holder's next request into a 401.
    if (status === "SUSPENDED") await revokeAllForUser(row.user.id, "membership suspended");
    const updated = await tx.membership.findFirstOrThrow({ where: { id: membershipId }, select: ROW });
    return { ok: true as const, value: toMember(updated as Row) };
  });
}

/**
 * Issues a new temporary password and forces a change at next login.
 *
 * The plaintext is returned here and nowhere else: it is hashed on the way in, so no later request
 * can read it back and no log line can carry it.
 */
export async function resetStaffPassword(
  caller: StaffCaller,
  membershipId: string,
): Promise<StaffResult<{ temporaryPassword: string }>> {
  const row = await withTenant(caller.tenantId, caller.actor, (tx) =>
    tx.membership.findFirst({ where: { id: membershipId }, select: { userId: true } }),
  );
  if (row === null) {
    return { ok: false, code: "NOT_FOUND", params: { resource: "membership" } };
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  await withTenant(caller.tenantId, caller.actor, (tx) =>
    tx.user.update({
      where: { id: row.userId },
      data: { passwordHash, mustChangePassword: true },
    }),
  );

  return { ok: true, value: { temporaryPassword } };
}
