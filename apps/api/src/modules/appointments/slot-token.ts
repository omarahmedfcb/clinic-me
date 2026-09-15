import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The opaque slot token — PHASE-2.md §5, Q24.
 *
 * ARCHITECTURE.md §12 rule 1 says hallucinated availability is *architecturally* impossible: the
 * model "is never asked to reason about times; it selects from a returned list". That is only
 * true if booking takes something the model could not have invented. If `create_appointment()`
 * accepted a raw start time, the model could send a time we never offered and the guarantee would
 * rest entirely on its good behaviour — a statement about a language model, not a property of the
 * system.
 *
 * So `find_available_slots()` mints a signed token per slot, and booking uses **the token's**
 * values, never the request's. A time that was never offered has no valid token.
 *
 * ## Stateless, deliberately
 *
 * No table, no cleanup job; the TTL bounds the exposure. The trade is that a token cannot be
 * revoked when someone else takes the slot in the meantime — and that is acceptable **because the
 * token was never the availability guarantee.** `no_double_booking` is. The token guarantees only
 * "we offered this"; the constraint independently guarantees "this is still free". Two claims, two
 * mechanisms, neither standing in for the other.
 *
 * ## Not a JWT
 *
 * A JWT would drag in an algorithm field the verifier has to be careful about, and this value
 * never leaves our own request/response cycle. A fixed HMAC with no negotiable parameters has no
 * `alg: none` to get wrong.
 */

/** Ten minutes. Long enough for a WhatsApp exchange, short enough that a stale list expires. */
export const SLOT_TOKEN_TTL_MS = 10 * 60_000;

export interface SlotClaims {
  tenantId: string;
  doctorId: string;
  serviceId: string;
  startMs: number;
  endMs: number;
  expiresAtMs: number;
  nonce: string;
}

export type SlotTokenFailure =
  | "MALFORMED"
  | "BAD_SIGNATURE"
  | "EXPIRED"
  | "WRONG_TENANT";

/**
 * **An expired token carries its claims; no other failure does.**
 *
 * The signature is verified before expiry, so by the time a token is called expired this module has
 * already established that this clinic minted it and that its fields are ours. The caller needs the
 * slot time to tell "the offer went stale" from "the time itself has gone" — and since 2026-09-13
 * the second is the sentence whenever both are true. A malformed or forged token has no claims worth
 * reading, and a token for another tenant is not answered with its contents.
 */
export type SlotTokenResult =
  | { ok: true; claims: SlotClaims }
  | { ok: false; failure: "EXPIRED"; claims: SlotClaims }
  | { ok: false; failure: Exclude<SlotTokenFailure, "EXPIRED"> };

/**
 * Field order is fixed and the separator cannot appear in any field: ids are UUIDs, the numbers
 * are integers, and the nonce is hex. Signing a delimited string rather than `JSON.stringify`
 * output avoids depending on key order, which is stable in practice and not guaranteed by spec.
 */
function payload(claims: SlotClaims): string {
  return [
    claims.tenantId,
    claims.doctorId,
    claims.serviceId,
    String(claims.startMs),
    String(claims.endMs),
    String(claims.expiresAtMs),
    claims.nonce,
  ].join(".");
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/**
 * The secret is read per call rather than captured at module load.
 *
 * `src/prisma/client.ts` reads its environment at module scope, and CLAUDE.md records four CI
 * failures rooted in exactly that: a module-scope read makes every importer depend on a variable
 * being present at import time, which is true locally and false on a machine with no `.env`.
 * Reading here keeps this module importable by a unit spec that never mints a token.
 */
function secret(): string {
  const value = process.env["SLOT_TOKEN_SECRET"];
  if (value === undefined || value.length < 32) {
    throw new Error(
      "SLOT_TOKEN_SECRET must be set and at least 32 characters. It signs slot tokens, which are " +
        "what make ARCHITECTURE.md §12 rule 1 structurally true rather than a claim about model " +
        "behaviour. See .env.example and docs/SETUP.md.",
    );
  }
  return value;
}

export function mintSlotToken(
  claims: Omit<SlotClaims, "expiresAtMs" | "nonce">,
  now: Date,
): string {
  const full: SlotClaims = {
    ...claims,
    expiresAtMs: now.getTime() + SLOT_TOKEN_TTL_MS,
    // A nonce makes two tokens for the same slot distinguishable in logs. It is not a replay
    // defence -- the exclusion constraint is what stops a slot being booked twice.
    nonce: randomBytes(9).toString("hex"),
  };
  const body = payload(full);
  return `${Buffer.from(body).toString("base64url")}.${sign(body, secret())}`;
}

/**
 * Verify a token and return its claims.
 *
 * Absence of validity is a **value**, not an exception, for the same reason it is in
 * `patients.service.ts`: the AI tool layer has no HTTP in it, and would otherwise have to catch a
 * framework error to learn that a token expired.
 *
 * `expectedTenantId` comes from the validated JWT or the webhook's `phone_number_id` resolution —
 * never from the request body. A token minted for another tenant is refused even though its
 * signature is perfectly valid, which is what stops a token being a cross-tenant capability.
 */
export function verifySlotToken(
  token: string,
  expectedTenantId: string,
  now: Date,
): SlotTokenResult {
  const parts = token.split(".");
  if (parts.length !== 2) return { ok: false, failure: "MALFORMED" };

  const [encoded, signature] = parts as [string, string];
  let body: string;
  try {
    body = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return { ok: false, failure: "MALFORMED" };
  }

  const expected = sign(body, secret());
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Length is checked first because timingSafeEqual throws on a mismatch. The length of an HMAC
  // is not a secret, so leaking it through an early return costs nothing.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, failure: "BAD_SIGNATURE" };
  }

  const fields = body.split(".");
  if (fields.length !== 7) return { ok: false, failure: "MALFORMED" };
  const [tenantId, doctorId, serviceId, startMs, endMs, expiresAtMs, nonce] = fields as [
    string, string, string, string, string, string, string,
  ];

  const claims: SlotClaims = {
    tenantId,
    doctorId,
    serviceId,
    startMs: Number(startMs),
    endMs: Number(endMs),
    expiresAtMs: Number(expiresAtMs),
    nonce,
  };
  if (!Number.isFinite(claims.startMs) || !Number.isFinite(claims.endMs)) {
    return { ok: false, failure: "MALFORMED" };
  }

  // Signature checked before expiry and tenant, so a forged token is never told which of its
  // fabricated fields would have been wrong.
  //
  // The tenant is checked before expiry is *reported*, so claims never travel back to a caller the
  // token was not minted for — expiry order is unchanged, only which failure carries its contents.
  if (now.getTime() > claims.expiresAtMs) {
    return claims.tenantId === expectedTenantId
      ? { ok: false, failure: "EXPIRED", claims }
      : { ok: false, failure: "WRONG_TENANT" };
  }
  if (claims.tenantId !== expectedTenantId) return { ok: false, failure: "WRONG_TENANT" };

  return { ok: true, claims };
}
