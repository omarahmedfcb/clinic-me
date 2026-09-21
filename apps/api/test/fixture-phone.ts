// Fixture phone numbers that survive the login's own normaliser. Pure: no database import, so the
// unit project can hold the guard that proves it.

import { loginCountry, normalisePhone } from "../src/modules/auth/phone.ts";

// Sequential from a random start, so two phones never collide inside one process and two processes
// are unlikely to pick the same run of numbers.
const base = Math.floor(Math.random() * 100_000_000);
let issued = 0;

/**
 * A unique `+2010########` that satisfies `normalisePhone(phone, loginCountry()) === phone`.
 *
 * **Why the round-trip is asserted here rather than assumed.** Both login controllers resolve an
 * identifier as `normalisePhone(body.identifier, loginCountry()) ?? body.identifier`, so a stored
 * phone the normaliser rewrites can never be logged into. The previous generator built phones from
 * the first eight *hex* characters of a UUID; libphonenumber truncates a trailing letter run and
 * returns the numeric prefix, so 2.27% of fixture users were unreachable through their own login
 * and the integration suite failed roughly one run in five with an unexplained 401.
 *
 * Throwing at creation is the point: a fixture that cannot log in must fail where it is built, not
 * as a 401 in an unrelated spec a thousand lines away.
 */
export function generateFixturePhone(prefix = "+2010"): string {
  const digits = String((base + issued++) % 100_000_000).padStart(8, "0");
  const phone = `${prefix}${digits}`;

  const normalised = normalisePhone(phone, loginCountry());
  if (normalised !== phone) {
    throw new Error(
      `generateFixturePhone produced ${phone}, which normalises to ${String(normalised)}. ` +
        "A fixture phone that does not round-trip cannot be logged into.",
    );
  }
  return phone;
}
