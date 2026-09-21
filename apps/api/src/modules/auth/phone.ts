import { parsePhoneNumberFromString } from "libphonenumber-js";

/**
 * Turning what a receptionist typed into an E.164 login identifier.
 *
 * Phone is the identifier, not email (PHASE-1 §3): Egyptian clinic staff have phones, and many
 * have no work email at all. That makes this function the front door, and it has to accept the
 * ways a real person types a number rather than one canonical form.
 *
 * ## Arabic-Indic digits
 *
 * An Arabic keyboard produces ٠١٢٣٤٥٦٧٨٩ (U+0660–U+0669), and an Arabic *phone* keypad on some
 * Android builds produces the Eastern Arabic-Indic set ۰۱۲۳۴۵۶۷۸۹ (U+06F0–U+06F9). Both are
 * digits to the person typing them and neither survives `parseInt`. A receptionist who types her
 * own number in Arabic numerals and is told "invalid phone number" has been told the system is
 * broken, and she is not wrong.
 *
 * Both ranges are folded to ASCII before parsing. This is transliteration of *digits*, which is
 * lossless and unambiguous — unlike the transliteration of names (D19), where it is neither.
 *
 * ## Why parsing, not a regex
 *
 * `libphonenumber-js` with the tenant's country as a hint (CLAUDE.md: never assume +20). It
 * accepts `01001234567`, `+20 100 123 4567`, `0100 123 4567` and `(0100) 123-4567` as the same
 * number, which is what a human means by them.
 */

/** U+0660–U+0669 (Arabic-Indic) and U+06F0–U+06F9 (Extended/Persian). */
const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/**
 * Folds Arabic-Indic and Extended Arabic-Indic digits to ASCII, leaving everything else alone.
 *
 * Exported separately from `normalisePhone` because it is useful anywhere a human types a number
 * — a national ID, an amount — and because it is worth testing on its own.
 */
export function toLatinDigits(input: string): string {
  let out = "";
  for (const character of input) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      out += String(code - ARABIC_INDIC_ZERO);
    } else if (code >= EXTENDED_ARABIC_INDIC_ZERO && code <= EXTENDED_ARABIC_INDIC_ZERO + 9) {
      out += String(code - EXTENDED_ARABIC_INDIC_ZERO);
    } else {
      out += character;
    }
  }
  return out;
}

/**
 * Parses a typed phone number to E.164, or returns null.
 *
 * `defaultCountry` is the tenant's country and has no default here on purpose. CLAUDE.md forbids
 * assuming +20, and a parameter with a default is an assumption that no longer looks like one.
 *
 * Returns null rather than throwing: at the login boundary an unparseable identifier and a
 * non-existent account must be indistinguishable to the caller, so this has to be a value the
 * controller can fold into the same response as "no such user" — not an exception with its own
 * shape and its own status code.
 */
/** Formatting a human adds, and nothing else: spaces, dashes, parentheses, dots. */
const FORMATTING = /[\s\-().]/g;

/** What is left must be digits, optionally behind one leading `+`. Anything else is not a phone. */
const PHONE_SHAPE = /^\+?\d+$/;

export function normalisePhone(input: string, defaultCountry: "EG" | "SA" | "AE"): string | null {
  const latin = toLatinDigits(input).trim();
  if (latin.length === 0) return null;

  // An email is an identifier, not a phone, and must never be rewritten into one.
  if (latin.includes("@")) return null;

  const stripped = latin.replace(FORMATTING, "");
  const candidate = stripped.startsWith("00") ? `+${stripped.slice(2)}` : stripped;

  /*
   * The shape is checked before parsing, because libphonenumber is lenient: given
   * `+2010128538ff` it extracts the valid numeric prefix and returns `+2010128538`, silently
   * authenticating a different number from the one typed. Ruled 2026-09-16 after that leniency
   * made 2.27% of fixture users unreachable through their own login.
   */
  if (!PHONE_SHAPE.test(candidate)) return null;

  const parsed = parsePhoneNumberFromString(candidate, defaultCountry);
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * Country hint for parsing a typed phone number. From the environment, not hardcoded: CLAUDE.md
 * forbids assuming +20, and at login there is no tenant yet to read a country from -- discovering
 * which tenants a user belongs to is what logging in is for.
 *
 * Moved here from `auth.controller.ts` when the platform login needed the same hint (0a): two
 * copies of "which country do we parse against" is the shape that drifts.
 */
export function loginCountry(): "EG" | "SA" | "AE" {
  const configured = process.env["DEFAULT_PHONE_COUNTRY"];
  return configured === "SA" || configured === "AE" ? configured : "EG";
}
