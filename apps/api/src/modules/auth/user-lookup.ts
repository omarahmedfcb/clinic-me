import { randomUUID } from "node:crypto";
import type { MembershipRole } from "../../generated/prisma/client.ts";
import { prisma } from "../../prisma/client.ts";
import { hashPassword, verifyPasswordHash } from "./password.ts";

export interface AuthenticatedUser {
  id: string;
  fullName: string;
  phoneE164: string;
  email: string | null;
  isPlatformAdmin: boolean;
  /** PR 10: a temporary password is outstanding, so every route but the change refuses. */
  mustChangePassword: boolean;
  /** Whether a second factor is confirmed. Null for everyone who has never enrolled one. */
  totpConfirmedAt: Date | null;
}

export interface ActiveMembership {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: MembershipRole;
}

/**
 * Argon2 hashing is deliberately slow, so "user not found" (fast) and "user found, wrong
 * password" (slow -- a real hash verify) would otherwise be distinguishable by response time,
 * letting an attacker enumerate valid phone numbers/emails without ever guessing a password.
 * verifyCredentials() always performs a real verify() call against SOME hash, computed once and
 * cached here, so the two cases take the same time. The password is thrown away; only the
 * argon2id string shape needs to look real to the verify() call.
 */
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomUUID());
  return dummyHash;
}

/**
 * Verifies a login identifier (phone or email) + password against `users`. Returns null for
 * "no such user", "wrong password", and "user not ACTIVE" alike -- the caller must not
 * distinguish these in any response, or the same enumeration problem the timing-safety above
 * guards against reopens at the response-content layer instead.
 */
export async function verifyCredentials(identifier: string, password: string): Promise<AuthenticatedUser | null> {
  const user = await prisma.user.findFirst({
    where: { OR: [{ phoneE164: identifier }, { email: identifier }] },
  });

  const hashToVerify = user?.passwordHash ?? (await getDummyHash());
  const passwordValid = await verifyPasswordHash(hashToVerify, password);

  if (!user || !passwordValid || user.status !== "ACTIVE") return null;

  return {
    id: user.id,
    fullName: user.fullName,
    phoneE164: user.phoneE164,
    email: user.email,
    isPlatformAdmin: user.isPlatformAdmin,
    mustChangePassword: user.mustChangePassword,
    totpConfirmedAt: user.totpConfirmedAt,
  };
}

/**
 * Lists the tenants a user can log into -- membership ACTIVE, tenant ACTIVE. This is inherently a
 * cross-tenant query: the whole point is discovering which tenant(s) a user belongs to *before*
 * any tenant is known, which is exactly the operation the tenant-scoping extension's `Membership:
 * "scoped"` classification (tenant-scoped-models.ts) exists to forbid everywhere else -- and,
 * since SCHEMA-DECISIONS.md D15, exactly what Postgres RLS on `memberships` also enforces at the
 * database layer. Calls the `list_active_memberships_for_user` SQL function
 * (prisma/sql/04-membership-lookup-functions.sql) instead of querying the table directly: it's a
 * SECURITY DEFINER function, so it runs with the migration owner's privileges (bypassing RLS)
 * regardless of who calls it, rather than clinic_os_app needing any broader bypass. It must only
 * ever be called with a userId that has already been authenticated by verifyCredentials() above,
 * never with unverified caller input -- there is no tenant filter to fall back on if that
 * invariant is broken, RLS included.
 */
export async function listActiveMemberships(userId: string): Promise<ActiveMembership[]> {
  return prisma.$queryRaw<ActiveMembership[]>`
    SELECT membership_id AS "membershipId", tenant_id AS "tenantId", tenant_name AS "tenantName",
           tenant_slug AS "tenantSlug", role AS "role"
    FROM list_active_memberships_for_user(${userId}::uuid)
  `;
}
