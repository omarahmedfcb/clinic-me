// RFC 6238 TOTP on `node:crypto` — the operator's second factor. Pure: every function takes the
// instant it is checked against, so a spec can pin a code rather than race the clock.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Why this is thirty lines here rather than a package.
 *
 * `CLAUDE.md` requires asking before adding a dependency, and TOTP is one HMAC and a truncation —
 * the whole of RFC 6238 that a verifier needs. A package would also arrive with a QR renderer, and
 * the enrolment below deliberately has none: it hands over the `otpauth://` URI and the base32
 * secret, which every authenticator accepts by paste. Flagged to the founder either way.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The window, in seconds. Thirty is what every authenticator app assumes. */
export const TOTP_STEP_SECONDS = 30;

/**
 * How many steps either side of the current one are accepted.
 *
 * One, not zero: a phone's clock drifts, and a code typed at the very end of its window arrives in
 * the next one. Three windows is ninety seconds of validity, which is the usual trade and is the
 * reason a used code must not be replayable for longer than that.
 */
export const TOTP_DRIFT_STEPS = 1;

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Returns null for anything that is not well-formed base32, rather than throwing on user input. */
export function base32Decode(input: string): Buffer | null {
  const cleaned = input.replace(/[\s=]/g, "").toUpperCase();
  if (cleaned.length === 0) return null;

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const character of cleaned) {
    const index = ALPHABET.indexOf(character);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The six-digit code for one step. `counter` is `floor(epochSeconds / TOTP_STEP_SECONDS)`. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();

  // Dynamic truncation, RFC 4226 §5.4: the low nibble of the last byte picks the offset.
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    (((digest[offset + 1] ?? 0) & 0xff) << 16) |
    (((digest[offset + 2] ?? 0) & 0xff) << 8) |
    ((digest[offset + 3] ?? 0) & 0xff);

  return (binary % 10 ** digits).toString().padStart(digits, "0");
}

/** The code an authenticator shows at `atEpochSeconds`. The instant is a parameter, never the clock. */
export function totpCode(secretBase32: string, atEpochSeconds: number): string | null {
  const secret = base32Decode(secretBase32);
  if (secret === null || secret.length === 0) return null;
  return hotp(secret, Math.floor(atEpochSeconds / TOTP_STEP_SECONDS));
}

/**
 * Whether `submitted` is a live code for `secretBase32` at `atEpochSeconds`.
 *
 * Compared with `timingSafeEqual`, like a password: a six-digit space is small enough that a
 * length-of-match timing signal is worth removing even though the code expires in ninety seconds.
 */
export function verifyTotp(secretBase32: string, submitted: string, atEpochSeconds: number): boolean {
  const cleaned = submitted.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return false;

  const secret = base32Decode(secretBase32);
  if (secret === null || secret.length === 0) return false;

  const current = Math.floor(atEpochSeconds / TOTP_STEP_SECONDS);
  let matched = false;
  for (let step = -TOTP_DRIFT_STEPS; step <= TOTP_DRIFT_STEPS; step += 1) {
    const candidate = Buffer.from(hotp(secret, current + step));
    // No early return: every window costs the same, so the loop leaks nothing about which matched.
    if (candidate.length === cleaned.length && timingSafeEqual(candidate, Buffer.from(cleaned))) {
      matched = true;
    }
  }
  return matched;
}

/**
 * The `otpauth://` URI an authenticator imports.
 *
 * `issuer` is repeated in the label as well as the parameter because several apps read only one of
 * the two, and an operator with three accounts needs to tell them apart.
 */
export function otpauthUri(input: { secretBase32: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`);
  const parameters = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}
