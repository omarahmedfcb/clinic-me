import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { MembershipRole } from "../../generated/prisma/client.ts";
import { prisma } from "../../prisma/client.ts";
import { issueAccessToken } from "./jwt.ts";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class RefreshTokenInvalidError extends Error {}
export class RefreshTokenReuseDetectedError extends Error {}
export class RefreshTokenExpiredError extends Error {}
export class MembershipNotActiveError extends Error {}

export interface SessionPair {
  accessToken: string;
  refreshToken: string;
}

interface MembershipContext {
  membershipId: string;
  tenantId: string;
  role: MembershipRole;
}

function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * SHA-256, not Argon2 -- this hashes an already-high-entropy 256-bit random token for O(1)
 * lookup, not a user-chosen password. Argon2's deliberate slowness defends against guessing a
 * low-entropy secret; there is nothing to guess here, and hashing 30-day-lived tokens with a slow
 * KDF would only add unnecessary latency to every refresh.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Resolves whether `membershipId` is currently usable by `userId` -- ACTIVE membership in an
 * ACTIVE tenant, the same invariant listActiveMemberships() (user-lookup.ts) enforces for login.
 * Re-checked on every rotation, not just at initial login: this is what makes a membership
 * revoked mid-session stop working on its very next refresh, rather than staying valid until the
 * access token's own 15-minute expiry and the refresh token's 30-day one.
 *
 * Calls the `resolve_active_membership` SQL function (prisma/sql/04-membership-lookup-functions.sql),
 * not the table directly: `memberships` has been RLS-protected since SCHEMA-DECISIONS.md D15, and
 * this lookup is inherently cross-tenant (the caller doesn't yet know -- or is deliberately
 * changing -- which tenant applies), which no single bound app.current_tenant_id can express. The
 * function is SECURITY DEFINER, running with the migration owner's privileges regardless of
 * caller, so clinic_os_app never needs a broader RLS bypass than this one specific lookup.
 */
async function resolveActiveMembership(userId: string, membershipId: string): Promise<MembershipContext | null> {
  const rows = await prisma.$queryRaw<MembershipContext[]>`
    SELECT membership_id AS "membershipId", tenant_id AS "tenantId", role AS "role"
    FROM resolve_active_membership(${userId}::uuid, ${membershipId}::uuid)
  `;
  return rows[0] ?? null;
}

/**
 * Every live session for one person, ended.
 *
 * Used when an admin issues a temporary password: the holder of an already-open session would
 * otherwise keep working for as long as their access token lasts, which is a password reset that
 * did not reset anything for up to fifteen minutes.
 */
export async function revokeAllForUser(userId: string, reason: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

export async function revokeFamily(familyId: string, reason: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

async function issueTokenPair(args: {
  userId: string;
  familyId: string;
  parentTokenId: string | null;
  membership: MembershipContext;
  ipAddress: string;
  userAgent: string;
}): Promise<SessionPair> {
  const refreshToken = generateOpaqueToken();
  await prisma.refreshToken.create({
    data: {
      id: randomUUID(),
      userId: args.userId,
      membershipId: args.membership.membershipId,
      tokenHash: hashToken(refreshToken),
      familyId: args.familyId,
      parentTokenId: args.parentTokenId,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      ipAddress: args.ipAddress,
      userAgent: args.userAgent,
    },
  });

  const accessToken = await issueAccessToken({
    sub: args.userId,
    membershipId: args.membership.membershipId,
    tenantId: args.membership.tenantId,
    role: args.membership.role,
  });

  return { accessToken, refreshToken };
}

/**
 * Revokes the whole family a presented token belongs to. This is logout.
 *
 * A family, not a token: logging out on one device must end the session, and the session is the
 * chain of rotations, not the one token the client happens to be holding. Revoking a single row
 * would leave any already-rotated descendant usable.
 *
 * Silent when the token is unrecognised. Logout is idempotent by nature -- a client with a stale
 * or already-revoked cookie is trying to reach the state it is already in -- and reporting "no such
 * token" would tell an unauthenticated caller whether a token value exists.
 */
export async function revokeFamilyForToken(presentedToken: string, reason: string): Promise<void> {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(presentedToken) } });
  if (!row) return;
  await revokeFamily(row.familyId, reason);
}

/** Starts a brand new refresh-token family -- the first token issued after a successful login. */
export async function issueSession(
  userId: string,
  membershipId: string,
  ipAddress: string,
  userAgent: string,
): Promise<SessionPair> {
  const membership = await resolveActiveMembership(userId, membershipId);
  if (!membership) throw new MembershipNotActiveError("That membership is not active for this user.");

  return issueTokenPair({
    userId,
    familyId: randomUUID(),
    parentTokenId: null,
    membership,
    ipAddress,
    userAgent,
  });
}

async function rotate(
  presentedToken: string,
  ipAddress: string,
  userAgent: string,
  targetMembershipId?: string,
): Promise<SessionPair> {
  const tokenHash = hashToken(presentedToken);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!row) throw new RefreshTokenInvalidError("Refresh token not recognised.");

  if (row.revokedAt) {
    await revokeFamily(row.familyId, "reuse_detected");
    throw new RefreshTokenReuseDetectedError(
      "This refresh token was already used. The entire session family has been revoked; log in again.",
    );
  }

  if (row.expiresAt.getTime() < Date.now()) {
    throw new RefreshTokenExpiredError("Refresh token has expired.");
  }

  const membership = await resolveActiveMembership(row.userId, targetMembershipId ?? row.membershipId ?? "");
  if (!membership) throw new MembershipNotActiveError("That membership is not active for this user.");

  // Atomic claim: only succeeds if this row is still unrevoked at the moment of the UPDATE,
  // closing the race between the read above and this write. Two concurrent rotation attempts
  // presenting the same token must not both succeed -- the loser here is treated exactly like
  // reuse, which is the correct response: a legitimate client never issues two rotation requests
  // for the same refresh token concurrently.
  const claimed = await prisma.refreshToken.updateMany({
    where: { id: row.id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: "rotated" },
  });
  if (claimed.count === 0) {
    await revokeFamily(row.familyId, "reuse_detected");
    throw new RefreshTokenReuseDetectedError(
      "This refresh token was already used. The entire session family has been revoked; log in again.",
    );
  }

  return issueTokenPair({
    userId: row.userId,
    familyId: row.familyId,
    parentTokenId: row.id,
    membership,
    ipAddress,
    userAgent,
  });
}

/** Rotates within the refresh token's current membership -- the ordinary "refresh my session" path. */
export async function rotateRefreshToken(
  presentedToken: string,
  ipAddress: string,
  userAgent: string,
): Promise<SessionPair> {
  return rotate(presentedToken, ipAddress, userAgent);
}

/**
 * Rotates into a different membership. Structurally identical to rotateRefreshToken() -- same
 * family, same reuse-detection -- except the new token pair is issued for `targetMembershipId`
 * instead of the presented token's current one, and that target is validated exactly like any
 * other membership resolution (belongs to this user, ACTIVE, tenant ACTIVE) before anything is
 * issued.
 */
export async function switchTenant(
  presentedToken: string,
  targetMembershipId: string,
  ipAddress: string,
  userAgent: string,
): Promise<SessionPair> {
  return rotate(presentedToken, ipAddress, userAgent, targetMembershipId);
}
