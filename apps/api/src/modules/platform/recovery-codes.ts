// The operator's recovery codes: what they look like, and how a typed one is read back.
// Pure — no database, no hashing — so the alphabet and the normalisation can be tested on their own.

import { randomBytes } from "node:crypto";

/**
 * No `0`/`O`, no `1`/`I`/`L`, and no `U`.
 *
 * A recovery code is read off paper or a downloaded file and typed by someone who has just lost
 * their phone, which is the worst moment to discover that a character was ambiguous. `U` is dropped
 * as well, following Crockford, because its absence makes accidental words much less likely.
 */
export const RECOVERY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

export const RECOVERY_CODE_LENGTH = 10;
export const RECOVERY_CODE_COUNT = 8;

/** Below this many unused codes the console nags, because the next loss is the one that locks out. */
export const LOW_REMAINING_THRESHOLD = 3;

/**
 * One code, drawn uniformly.
 *
 * Rejection sampling rather than `byte % alphabet.length`: 256 is not a multiple of 30, so the
 * modulo would make the first sixteen characters measurably likelier than the rest. The bias is
 * small and it is also free to avoid.
 */
export function generateRecoveryCode(): string {
  const limit = 256 - (256 % RECOVERY_ALPHABET.length);
  let code = "";

  while (code.length < RECOVERY_CODE_LENGTH) {
    for (const byte of randomBytes(RECOVERY_CODE_LENGTH)) {
      if (byte >= limit) continue;
      code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
      if (code.length === RECOVERY_CODE_LENGTH) break;
    }
  }
  return code;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => generateRecoveryCode());
}

/**
 * What the operator typed, as the stored code would have been written.
 *
 * Case and separators are forgiven — a code shown as `ABCDE-FGHJK` is commonly typed back with the
 * dash, or in lower case, and neither is a wrong code. Characters outside the alphabet are dropped
 * rather than rejected here: whether the result matches is the caller's question, and answering
 * "malformed" differently from "wrong" would tell an attacker which it was.
 */
export function normaliseRecoveryCode(input: string): string {
  const upper = input.toUpperCase();
  let out = "";
  for (const character of upper) {
    if (RECOVERY_ALPHABET.includes(character)) out += character;
  }
  return out;
}

/** Whether a normalised code is even the right shape to compare. Never surfaced to the caller. */
export const isWellFormedRecoveryCode = (normalised: string): boolean =>
  normalised.length === RECOVERY_CODE_LENGTH;
