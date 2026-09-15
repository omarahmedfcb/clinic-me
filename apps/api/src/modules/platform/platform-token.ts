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
const ALGORITHM = "HS256";

export interface PlatformTokenClaims {
  sub: string;
  kind: typeof PLATFORM_TOKEN_KIND;
}

function getSecretKey(): Uint8Array {
  const secret = process.env["JWT_SECRET"];
  if (!secret) throw new Error("JWT_SECRET is not set. See .env.example.");
  return new TextEncoder().encode(secret);
}

export async function issuePlatformToken(userId: string): Promise<string> {
  return new SignJWT({ kind: PLATFORM_TOKEN_KIND })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${PLATFORM_TOKEN_TTL_SECONDS}s`)
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
    return { sub: payload.sub, kind: PLATFORM_TOKEN_KIND };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new AccessTokenExpiredError("Platform token has expired.");
    }
    throw new AccessTokenInvalidError("Platform token is invalid.");
  }
}
