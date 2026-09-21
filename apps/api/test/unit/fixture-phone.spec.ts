/**
 * The fixture phone generator, and the hazard it exists to close.
 *
 * Both login controllers resolve `normalisePhone(identifier, loginCountry()) ?? identifier`, so a
 * stored phone the normaliser rewrites is a user who cannot log in. The third test pins the exact
 * shape that caused it — kept permanently, because the fix is invisible without the failure it
 * replaces.
 */

import { generateFixturePhone } from "../fixture-phone.ts";
import { loginCountry, normalisePhone } from "../../src/modules/auth/phone.ts";

const SAMPLES = 1000;

describe("fixture phone numbers", () => {
  test("1,000 generated phones all round-trip through the login's own normaliser", () => {
    const offenders: { phone: string; normalised: string | null }[] = [];

    for (let index = 0; index < SAMPLES; index += 1) {
      const phone = generateFixturePhone();
      const normalised = normalisePhone(phone, loginCountry());
      if (normalised !== phone) offenders.push({ phone, normalised: normalised ?? null });
    }

    expect(offenders).toEqual([]);
  });

  test("1,000 generated phones are unique", () => {
    const seen = new Set<string>();
    for (let index = 0; index < SAMPLES; index += 1) seen.add(generateFixturePhone());
    expect(seen.size).toBe(SAMPLES);
  });

  test("the shape this replaces does NOT round-trip — 2026-09-16, one suite run in five", () => {
    // `+2010` + the first eight hex characters of a UUID. It truncated to `+2010128538` until the
    // normaliser stopped rewriting non-phones; either way it is not what was stored, which is the
    // property that made the fixture user unreachable through their own login.
    const stored = "+2010128538ff";
    expect(normalisePhone(stored, loginCountry())).not.toBe(stored);
  });

  test("a hex suffix is now rejected outright rather than truncated", () => {
    expect(normalisePhone("+2010a1b2c3d4", loginCountry())).toBeNull();
    expect(normalisePhone("+2010128538ff", loginCountry())).toBeNull();
  });
});
