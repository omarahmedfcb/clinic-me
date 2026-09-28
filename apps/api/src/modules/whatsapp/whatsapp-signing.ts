// Verifying that an inbound webhook really came from Meta. Pure: no database import, so this can be
// unit-tested the way webhook-signing.ts (the *outbound* half, ours calling theirs) already is.
//
// This is a different scheme from webhook-signing.ts, and deliberately not shared with it: that one
// is ours, invented for this project (HMAC of "timestamp.body", a timestamp header we chose to add).
// This one is Meta's, fixed by the Cloud API and not ours to redesign -- HMAC-SHA256 of the raw body
// alone, hex, prefixed "sha256=", in one header, with no timestamp at all. Meta relies on TLS and its
// own retry/idempotency behaviour rather than a signed timestamp; there is nothing to add here.

import { createHmac, timingSafeEqual } from "node:crypto";

export const META_SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * Verifies `X-Hub-Signature-256` against the **raw** request body -- the exact bytes Meta sent, not
 * `JSON.stringify(req.body)`. Re-serializing a parsed object can reorder keys or change whitespace,
 * which changes the bytes the signature was computed over and makes a genuine delivery fail to
 * verify. `main.ts` enables Nest's `rawBody` option so `request.rawBody` is that exact buffer.
 */
export function verifyMetaSignature(appSecret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;

  const prefix = "sha256=";
  if (!header.startsWith(prefix)) return false;

  const expectedHex = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const expected = Buffer.from(expectedHex, "utf8");
  const given = Buffer.from(header.slice(prefix.length), "utf8");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Meta's one-time subscription handshake: `GET .../webhooks/whatsapp?hub.mode=subscribe&
 * hub.verify_token=...&hub.challenge=...`. Returns the challenge to echo back, or `null` to refuse.
 * `verifyToken` is a value we chose ourselves when registering the webhook in Meta's dashboard --
 * `WHATSAPP_VERIFY_TOKEN` -- and has nothing to do with the app secret used above.
 */
export function handleVerificationHandshake(
  verifyToken: string,
  query: Record<string, unknown>,
): string | null {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode !== "subscribe" || token !== verifyToken || typeof challenge !== "string") return null;
  return challenge;
}
