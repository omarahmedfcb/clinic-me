// Signing an outbound delivery. Pure: no database import, so the unit guard can exercise it.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "x-clinic-signature";
export const TIMESTAMP_HEADER = "x-clinic-timestamp";
export const IDEMPOTENCY_HEADER = "x-idempotency-key";

/** What the bot must reject as too old, per the contract. Here so both halves quote one number. */
export const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

/**
 * HMAC-SHA256 over `timestamp + "." + body`, hex.
 *
 * The timestamp is inside the signed string, not merely sent beside it: signing the body alone lets
 * anyone who has seen one delivery replay it forever with a fresh timestamp, which is the attack the
 * five-minute window is supposed to close.
 */
export function signWebhookBody(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/** The headers a delivery carries. `deliveryId` is the idempotency key, and retries reuse it. */
export function webhookHeaders(
  secret: string,
  body: string,
  deliveryId: string,
  now: Date,
): Record<string, string> {
  const timestamp = String(now.getTime());
  return {
    "content-type": "application/json",
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: signWebhookBody(secret, timestamp, body),
    [IDEMPOTENCY_HEADER]: deliveryId,
  };
}

/**
 * Verifies a signature the way the bot must. Exported for the acceptance suite the external
 * developer runs — a verifier we ship is one they cannot get subtly wrong.
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  now: Date,
): boolean {
  const age = now.getTime() - Number(timestamp);
  if (!Number.isFinite(age) || age > MAX_SIGNATURE_AGE_MS || age < -MAX_SIGNATURE_AGE_MS) return false;

  const expected = Buffer.from(signWebhookBody(secret, timestamp, body), "utf8");
  const given = Buffer.from(signature, "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A fresh signing secret: 32 random bytes, base64url, shown once beside the credential's own. */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("base64url");
}
