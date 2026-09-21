// The operator's token — Phase 5 pilot-readiness 0a. A separate shape from a clinic token, so the
// clinic guards cannot accept one and this surface cannot accept theirs.

import { SignJWT, jwtVerify, errors as joseErrors } from "jose";
import { AccessTokenExpiredError, AccessTokenInvalidError } from "../auth/jwt.ts";

/**
 * **A platform token carries no tenant, no membership and no role**, because the operator has none
 * of those. That is the whole reason it is a second shape rather than a clinic token with nullable
 * fields: making `tenantId` optional on `AccessTokenClaims` would weaken the claim every existing
 * guard reads, and the one invariant this product cannot afford to soften is tenant scoping.
 *
 * `kind` is what keeps the two apart in both directions. Both are signed with the same secret — a
 * second secret would be a second thing to rotate and lose — so the discriminator has to be inside
 * the payload, checked on the way in by each verifier.
 */
export const PLATFORM_TOKEN_KIND = "platform";

/** Fifteen minutes is the clinic token's life; the operator's is shorter because it is rarer. */
const PLATFORM_TOKEN_TTL_SECONDS = 10 * 60;

/**
 * A token that has passed the password and nothing else. Five minutes, and it opens exactly two
 * routes: enrol an authenticator, and answer its challenge.
 *
 * A separate claim rather than a separate token type, so that every verifier reads the same field
 * and a route that forgets to check it fails closed — `PlatformAuthGuard` demands `full`, so a
 * pending token is refused everywhere by default rather than everywhere it was remembered.
 */
const PENDING_TOKEN_TTL_SECONDS = 5 * 60;
const ALGORITHM = "HS256";

export type PlatformTokenStage = "pending" | "full";

export interface PlatformTokenClaims {
  sub: string;
  kind: typeof PLATFORM_TOKEN_KIND;
  /** `pending` until the second factor is answered. Only `full` opens the console. */
  stage: PlatformTokenStage;
  /**
   * How this session was opened. Absent means the authenticator answered.
   *
   * "recovery" means a recovery code did — a session that has NOT proved possession of the second
   * factor, only that somebody holds the paper. It is the only session allowed to replace the
   * authenticator, because the device that held it is the one that is gone.
   */
  via?: "recovery";
}

function getSecretKey(): Uint8Array {
  const secret = process.env["JWT_SECRET"];
  if (!secret) throw new Error("JWT_SECRET is not set. See .env.example.");
  return new TextEncoder().encode(secret);
}

export async function issuePlatformToken(
  userId: string,
  stage: PlatformTokenStage = "full",
  via?: "recovery",
): Promise<string> {
  const ttl = stage === "full" ? PLATFORM_TOKEN_TTL_SECONDS : PENDING_TOKEN_TTL_SECONDS;
  return new SignJWT({ kind: PLATFORM_TOKEN_KIND, stage, ...(via === undefined ? {} : { via }) })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(getSecretKey());
}

/**
 * Rejects anything that is not a platform token, a clinic token included.
 *
 * The check is positive — `kind` must equal the marker — rather than "does not look like a clinic
 * token". A negative check passes anything unforeseen, which is the wrong default for the door into
 * the operator's surface.
 */
export async function verifyPlatformToken(token: string): Promise<PlatformTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: [ALGORITHM] });
    if (payload["kind"] !== PLATFORM_TOKEN_KIND || typeof payload.sub !== "string") {
      throw new AccessTokenInvalidError("Not a platform token.");
    }
    // A token minted before `stage` existed has none. Treated as `pending`, not `full`: the
    // conservative reading of a missing claim is the one that opens nothing.
    const stage: PlatformTokenStage = payload["stage"] === "full" ? "full" : "pending";
    // Only the exact marker counts. Anything else is an ordinary session, which is the reading that
    // grants less: an unrecognised value must not open the authenticator-replacement route.
    const via = payload["via"] === "recovery" ? ("recovery" as const) : undefined;
    return { sub: payload.sub, kind: PLATFORM_TOKEN_KIND, stage, ...(via === undefined ? {} : { via }) };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new AccessTokenExpiredError("Platform token has expired.");
    }
    throw new AccessTokenInvalidError("Platform token is invalid.");
  }
}
