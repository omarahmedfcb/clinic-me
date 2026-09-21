import { normalisePhone, toLatinDigits } from "./phone.ts";

/**
 * Phone is the login identifier (PHASE-1 §3), so this is the front door and it has to accept what
 * a receptionist actually types — including Arabic numerals, which an Arabic keyboard produces by
 * default and which no amount of `parseInt` will read.
 */

describe("toLatinDigits", () => {
  test("folds Arabic-Indic digits, which an Arabic keyboard produces", () => {
    expect(toLatinDigits("٠١٢٣٤٥٦٧٨٩")).toBe("0123456789");
  });

  test("folds Extended Arabic-Indic digits, which some Arabic phone keypads produce", () => {
    // A different Unicode range for the same digits. Folding one and not the other would make the
    // system work on some Android builds and not others, which is the worst kind of half-support.
    expect(toLatinDigits("۰۱۲۳۴۵۶۷۸۹")).toBe("0123456789");
  });

  test("leaves everything else untouched, including Arabic letters", () => {
    // Digit folding must not touch names. محمد contains no digits and must survive intact.
    expect(toLatinDigits("محمد ٠١٠٠")).toBe("محمد 0100");
    expect(toLatinDigits("+20 (100) 123-4567")).toBe("+20 (100) 123-4567");
  });

  test("handles a mixed-script number, which is what copy-paste produces", () => {
    expect(toLatinDigits("+٢٠1٠٠1234567")).toBe("+201001234567");
  });
});

describe("normalisePhone", () => {
  const EXPECTED = "+201001234567";

  test("accepts the same number typed the ways a human types it", () => {
    for (const typed of [
      "+201001234567",
      "01001234567",
      "+20 100 123 4567",
      "0100 123 4567",
      "(0100) 123-4567",
      "  01001234567  ",
    ]) {
      expect({ typed, parsed: normalisePhone(typed, "EG") }).toEqual({ typed, parsed: EXPECTED });
    }
  });

  test("accepts it in Arabic numerals, in both ranges", () => {
    // The case this function mainly exists for.
    expect(normalisePhone("٠١٠٠١٢٣٤٥٦٧", "EG")).toBe(EXPECTED);
    expect(normalisePhone("۰۱۰۰۱۲۳۴۵۶۷", "EG")).toBe(EXPECTED);
    expect(normalisePhone("+٢٠ ١٠٠ ١٢٣ ٤٥٦٧", "EG")).toBe(EXPECTED);
  });

  test("returns null rather than throwing, so login can fold it into one response", () => {
    // An unparseable identifier and a non-existent account must be indistinguishable at the
    // boundary. An exception would have its own shape and its own status code, which is a
    // difference an attacker can measure.
    for (const invalid of ["", "   ", "not a phone", "12", "+999999999999999999"]) {
      expect({ invalid, parsed: normalisePhone(invalid, "EG") }).toEqual({ invalid, parsed: null });
    }
  });

  test("the country hint is load-bearing, not decoration", () => {
    // The same national-format digits mean different numbers in different countries. CLAUDE.md
    // forbids assuming +20, and this is why: 0100... is Egyptian only if you were told so.
    expect(normalisePhone("0100 123 4567", "EG")).toBe("+201001234567");
    expect(normalisePhone("050 123 4567", "AE")).toBe("+971501234567");
    expect(normalisePhone("050 123 4567", "SA")).toBe("+966501234567");
  });

  test("never rewrites a non-phone into a phone", () => {
    // Ruled 2026-09-16. libphonenumber is lenient: given trailing junk it extracts the valid
    // numeric prefix, so `+2010128538ff` came back as `+2010128538` — a DIFFERENT number, which
    // the login then looked up and did not find. The shape is now checked before parsing.
    expect(normalisePhone("+2010128538ff", "EG")).toBeNull();
    expect(normalisePhone("+201001234567-drop-this", "EG")).toBeNull();
    expect(normalisePhone("+2010a1b2c3d4", "EG")).toBeNull();
  });

  test("an email is an identifier, not a phone, and is never normalised", () => {
    // The controller falls back to the raw string, so email login still works — it just does not
    // travel through a phone parser on the way.
    expect(normalisePhone("amira@clinic.example", "EG")).toBeNull();
    expect(normalisePhone("+201001234567@clinic.example", "EG")).toBeNull();
  });

  test("still accepts the international prefix written as 00", () => {
    expect(normalisePhone("00201001234567", "EG")).toBe(EXPECTED);
  });

  test("an Egyptian mobile typed with the country code and a leading zero still resolves", () => {
    // +20 0100... is a common paste artefact: the country code kept and the trunk zero not dropped.
    expect(normalisePhone("+20 0100 123 4567", "EG")).toBe(EXPECTED);
  });
});
