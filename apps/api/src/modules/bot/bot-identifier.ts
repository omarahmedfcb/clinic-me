// The identifier a bot's `users` row carries in place of a phone number. Pure: no database import,
// so the unit guard that proves a person can never hold one can import it.

import { randomInt } from "node:crypto";

/**
 * **+999 is reserved by the ITU and assigned to no country**, so `normalisePhone` cannot produce it
 * from anything a human types and no real handset can be reached on it.
 *
 * `users.phoneE164` is required and is the login identifier, and a bot has no phone. Filling it with
 * a random but plausible Egyptian mobile — which is what this did until 2026-09-18 — puts a
 * real-looking number in the users table that nobody downstream can tell from a real one: a reader,
 * an export, a future feature that dials or messages a stored number, and the unique index a real
 * member of staff signs up against.
 */
export const BOT_IDENTIFIER_PREFIX = "+999";

/** Digits after the prefix. Eleven keeps the whole identifier inside E.164's 15-digit maximum. */
const DIGITS = 11;

/**
 * A fresh bot identifier: the reserved prefix and eleven random digits.
 *
 * Random rather than derived from the clock, because two clinics issuing in the same millisecond
 * collided on the unique index and the clinic that lost saw a 500 rather than anything true.
 */
export function botUserIdentifier(): string {
  const digits = String(randomInt(0, 100_000_000_000)).padStart(DIGITS, "0");
  return `${BOT_IDENTIFIER_PREFIX}${digits}`;
}

/** Whether an identifier is a bot's. Used by the guard, and by anything that must not dial one. */
export function isBotIdentifier(value: string): boolean {
  return new RegExp(`^\\${BOT_IDENTIFIER_PREFIX}\\d{${DIGITS}}$`).test(value);
}
