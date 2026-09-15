import { ageInYears } from "../../../web/src/domain/age.ts";

/**
 * Lives in `apps/api/test/unit/` rather than beside the source it tests, because **`apps/web` has
 * no test runner** — its scripts are dev, build, typecheck, preview and a Playwright smoke, and
 * nothing there would ever execute a `.spec.ts`. A spec that never runs is worse than no spec: it
 * looks like coverage.
 *
 * The API's unit project already reaches across for exactly this reason — see
 * `web-locale.spec.ts`, `shell-navigation.spec.ts` and `web-dev-only-packages.spec.ts`.
 */

/**
 * The cases that separate calendar arithmetic from dividing by an average year — which is what
 * `ClinicalSection` does today, and which is wrong by a day for anyone born near this date.
 */
describe("ageInYears", () => {
  const on = (iso: string): Date => new Date(`${iso}T12:00:00`);

  test("a birthday earlier this year has already happened", () => {
    expect(ageInYears("1990-03-15", on("2026-09-05"))).toBe(36);
  });

  test("a birthday later this year has not", () => {
    expect(ageInYears("1990-12-15", on("2026-09-05"))).toBe(35);
  });

  test("the birthday itself counts — you are your new age on the day", () => {
    expect(ageInYears("1990-09-05", on("2026-09-05"))).toBe(36);
  });

  test("the day before the birthday does not", () => {
    expect(ageInYears("1990-09-06", on("2026-09-05"))).toBe(35);
  });

  /**
   * A fortieth birthday, kept because it is the case an average-year division would be *expected*
   * to get wrong — and does not. Checked before this file claimed otherwise: across every birth
   * date from 1930 to today, `Math.floor(elapsed / 31_557_600_000)` agrees with calendar
   * arithmetic in every one. The Julian year drifts from the Gregorian by a day per 133 years,
   * which is outside a human lifespan.
   *
   * So this asserts the answer, not a difference. What the calendar version actually buys is a
   * testable `now` and a real `null`, neither of which is about the arithmetic.
   */
  test("a fortieth birthday reads as 40", () => {
    expect(ageInYears("1986-09-05", on("2026-09-05"))).toBe(40);
  });

  test("29 February does not become 1 March in a non-leap year", () => {
    // Born on a leap day; asked on 28 February of a non-leap year, the birthday has not arrived.
    expect(ageInYears("2000-02-29", on("2027-02-28"))).toBe(26);
    expect(ageInYears("2000-02-29", on("2027-03-01"))).toBe(27);
  });

  describe("returns null rather than a plausible-looking number", () => {
    test("when no date of birth was ever recorded", () => {
      expect(ageInYears(null, on("2026-09-05"))).toBeNull();
    });

    test("when the field is empty", () => {
      expect(ageInYears("", on("2026-09-05"))).toBeNull();
      expect(ageInYears("   ", on("2026-09-05"))).toBeNull();
    });

    test("when the date is in the future — data entry, not a negative age", () => {
      expect(ageInYears("2030-01-01", on("2026-09-05"))).toBeNull();
    });

    test("when the value is not a date at all", () => {
      expect(ageInYears("not-a-date", on("2026-09-05"))).toBeNull();
    });
  });

  test("a full ISO instant is accepted, and only its calendar part is used", () => {
    // Postgres DATE arrives as UTC midnight through JSON. Reading local components off a parsed
    // Date would shift it a day west of Greenwich; slicing the string cannot.
    expect(ageInYears("1990-03-15T00:00:00.000Z", on("2026-09-05"))).toBe(36);
  });

  test("a newborn is 0, which is a real age and not a missing one", () => {
    expect(ageInYears("2026-09-05", on("2026-09-05"))).toBe(0);
  });
});
