import { SignJWT, errors as joseErrors, jwtVerify } from "jose";
import type { MembershipRole } from "../../generated/prisma/client.ts";

export interface AccessTokenClaims {
  sub: string;
  membershipId: string;
  tenantId: string;
  role: MembershipRole;
  /** Present only on a support token: `sub` is the operator, `membershipId` the approving admin's (support access PR 3). */
  supportSessionId?: string;
}

/**
 * There is deliberately no `permissions` claim, and that was a decision rather than an omission.
 *
 * Permissions are derived from `role` through the §8 matrix (common/permissions.ts), so putting the
 * derived list in the token would create a second copy of an answer the server can compute in a map
 * lookup -- with its own lifetime, and no way for a reader to tell that a token is describing an
 * older matrix than the one now in force. A permission change would take up to fifteen minutes to
 * take effect and would do so invisibly.
 *
 * The level that settles it is `own` (ARCHITECTURE.md §8). A doctor's access to schedules is
 * own-scoped, and a flat string list cannot say *whose* without encoding the scope into the text --
 * at which point `"schedules:own"` is a two-field record with a colon in it and every consumer
 * becomes a parser. `permissionLevel(role, capability)` returns `full | own | none` as a value, and
 * `@RequirePermission("schedules", "own")` asks for it directly.
 *
 * `GET /auth/me` returns the derived list for the UI to hide controls with. That is a display hint,
 * computed server-side per request, and it authorises nothing.
 */

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const ALGORITHM = "HS256";

function getSecretKey(): Uint8Array {
  const secret = process.env["JWT_SECRET"];
  if (!secret) {
    throw new Error("JWT_SECRET is not set. See .env.example.");
  }
  return new TextEncoder().encode(secret);
}

export class AccessTokenExpiredError extends Error {}
export class AccessTokenInvalidError extends Error {}

export async function issueAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({
    membershipId: claims.membershipId,
    tenantId: claims.tenantId,
    role: claims.role,
  })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getSecretKey());
}

/**
 * Verifies signature, expiry, and algorithm (pinned to HS256 -- jose refuses to verify against
 * any other `alg`, closing the classic "attacker sets alg: none" class of JWT vulnerability by
 * construction rather than by remembering to check it here).
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: [ALGORITHM] });

    // **A platform token is not a clinic token** (pilot-readiness 0a). Both are signed with the
    // same secret, so a signature check alone would admit the operator's token here — and the casts
    // below would then hand every downstream guard `undefined` for `tenantId`, which is the single
    // value tenant scoping rests on. Checked positively: the three claims must be present.
    const { sub, membershipId, tenantId, role } = {
      sub: payload.sub,
      membershipId: payload["membershipId"],
      tenantId: payload["tenantId"],
      role: payload["role"],
    };
    if (
      typeof sub !== "string" ||
      typeof membershipId !== "string" ||
      typeof tenantId !== "string" ||
      typeof role !== "string"
    ) {
      throw new AccessTokenInvalidError("Access token is invalid.");
    }

    // A support token carries the same four claims, so it is told apart by audience and session: it is checked against its
    // live session on every request (support access PR 3), never accepted as an ordinary clinic login.
    const supportSessionId = payload["supportSessionId"];
    if (payload.aud === SUPPORT_AUDIENCE) {
      if (typeof supportSessionId !== "string") throw new AccessTokenInvalidError("Access token is invalid.");
      return { sub, membershipId, tenantId, role: role as MembershipRole, supportSessionId };
    }
    if (payload.aud !== undefined || supportSessionId !== undefined) throw new AccessTokenInvalidError("Access token is invalid.");

    return { sub, membershipId, tenantId, role: role as MembershipRole };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new AccessTokenExpiredError("Access token has expired.");
    }
    throw new AccessTokenInvalidError("Access token is invalid.");
  }
}

const SUPPORT_AUDIENCE = "clinic-os:support";
const SUPPORT_TOKEN_MAX_SECONDS = 10 * 60;

/** The operator's own id, the approver's membership, the session: at most ten minutes, never past the session's end. */
export async function issueSupportToken(claims: Required<AccessTokenClaims>, sessionExpiresAt: Date, now: Date): Promise<string> {
  const exp = Math.min(Math.floor(now.getTime() / 1000) + SUPPORT_TOKEN_MAX_SECONDS, Math.floor(sessionExpiresAt.getTime() / 1000));
  return new SignJWT({ membershipId: claims.membershipId, tenantId: claims.tenantId, role: claims.role, supportSessionId: claims.supportSessionId })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.sub)
    .setAudience(SUPPORT_AUDIENCE)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(exp)
    .sign(getSecretKey());
}
