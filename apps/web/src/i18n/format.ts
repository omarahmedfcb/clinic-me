import { DEFAULT_LOCALE, type Locale } from "./locale.ts";

/**
 * Number and currency formatting. Split out of the old flat `ar.ts` when `t()` replaced it.
 *
 * The `Intl` locale is derived from the interface language rather than hardcoded to `ar-EG`: an
 * English interface showing Arabic-Egyptian number formatting is the kind of half-switched result
 * that makes a language toggle look broken. `en-EG` rather than `en`, because the regional half is
 * what governs date order and grouping, and the clinic is in Egypt whichever language staff read.
 */
// `-u-nu-latn` is load-bearing: `ar-EG` alone resolves to Arabic-Indic digits, and dates and times
// render Latin ones (ruled 2026-09-12). Carried in the locale so no screen has to pass an option.
const INTL_LOCALE: Record<Locale, string> = { ar: "ar-EG-u-nu-latn", en: "en-EG-u-nu-latn" };

/**
 * The `Intl` locale for an interface language, for the screens that build their own formatters.
 *
 * Exported because the alternative is what actually happened: three screens hardcoded `ar-EG`
 * independently, and the notification panel rendered Arabic-Indic timestamps inside the English
 * interface -- the exact half-switched result the note above exists to prevent.
 *
 * **Every date and time formatter in the app must take its locale from here.** A bare
 * `toLocaleDateString()` uses the browser's locale, which ignores the language toggle *and* brings
 * Arabic-Indic digits back on an Arabic browser; `web-locale.spec.ts` fails the build on both.
 */
export function intlLocale(locale: Locale): string {
  return INTL_LOCALE[locale];
}

/**
 * Formats integer minor units as a currency amount.
 *
 * The currency code is a parameter because it lives in `tenants.currency` — there is deliberately
 * no hardcoded "EGP" in this codebase. Latin digits are used because that is what Egyptian clinics
 * read in software, and `.numeric` keeps the amount left-to-right inside Arabic text.
 *
 * **A major unit is not always 100 minor units.** KWD, BHD and JOD are three-decimal currencies;
 * JPY has no minor unit at all. Dividing by a hardcoded 100 would render every Kuwaiti amount ten
 * times too large. The exponent is therefore read from the currency itself rather than assumed.
 *
 * Storage stays integer (CLAUDE.md: money is never a float); the division happens here, at the
 * last possible moment, purely for display. It is exact for every value this system can hold: for
 * any integer below 2^53, the double nearest `n / 10^k` rounds back to `n` at `k` fraction digits,
 * which is what `Intl` then formats to.
 */
export function formatMinor(amountMinor: number, currency: string, locale: Locale = DEFAULT_LOCALE): string {
  const format = new Intl.NumberFormat(INTL_LOCALE[locale], {
    style: "currency",
    currency,
    numberingSystem: "latn",
  });

  // For `style: "currency"` the spec resolves this from the currency's own minor-unit exponent, so
  // the fallback is unreachable. It exists only because the type is optional across all styles; 2
  // is the most common exponent and the least surprising thing to fall back to.
  const exponent = format.resolvedOptions().minimumFractionDigits ?? 2;

  return format.format(amountMinor / 10 ** exponent);
}

/**
 * How many minor units make one major unit of this currency, as an exponent.
 *
 * Read from `Intl` rather than assumed, for the reason `formatMinor` gives at length: KWD, BHD and
 * JOD are three-decimal currencies and JPY has no minor unit at all, so a hardcoded 100 renders a
 * Kuwaiti amount ten times too large and a Japanese one a hundred times too small.
 *
 * Exported because two different jobs need it — formatting an amount for display, and converting
 * what an admin typed into storage — and a second hand-written copy of this rule is exactly the
 * drift this file exists to prevent.
 */
export function currencyExponent(currency: string): number {
  const format = new Intl.NumberFormat("en", { style: "currency", currency });
  return format.resolvedOptions().minimumFractionDigits ?? 2;
}

/**
 * Integer minor units as a plain major-unit string for an input field: `30000` → `"300"`.
 *
 * Deliberately **not** `formatMinor`. That one is for reading and includes a currency symbol and
 * locale grouping — `٣٠٠٫٠٠ ج.م.‏` — which is right in a table and wrong inside a text box, where
 * the value has to round-trip back through `majorToMinor` unchanged. Trailing zeros are trimmed so
 * a price of 300 reads `300` rather than `300.00`, which is what an admin expects to see in a field
 * they are about to edit.
 */
export function minorToMajorInput(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  if (exponent === 0) return String(amountMinor);
  const text = (amountMinor / 10 ** exponent).toFixed(exponent);
  return text.replace(/\.?0+$/, "");
}

/**
 * What an admin typed, as integer minor units. `null` when it is not a usable amount.
 *
 * **Rounds to the currency's precision rather than refusing.** Someone pasting `299.999` into an
 * EGP field means 300, and rejecting it would be pedantry with a red border attached; storing
 * `29999.9` would be worse still, because `price_minor` is an integer column and the fraction
 * would be lost somewhere less visible. `Math.round` on the scaled value keeps the money rule
 * intact — integer minor units, never a float in storage — while letting the field be forgiving.
 *
 * Negative is returned as-is rather than clamped: the DTO refuses it with a message naming the
 * field, and the database CHECK refuses it after that. Silently turning −5 into 0 would be this
 * layer inventing an amount nobody typed.
 */
export function majorToMinor(input: string, currency: string): number | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  // Latin digits and an optional single decimal point. Arabic-Indic digits are deliberately not
  // accepted here: `formatMinor` renders amounts in Latin digits throughout, so what an admin sees
  // is what this parses, and accepting a second numeral system would make the two disagree.
  if (!/^-?\d*\.?\d*$/.test(trimmed) || trimmed === "." || trimmed === "-") return null;

  const major = Number(trimmed);
  if (!Number.isFinite(major)) return null;

  return Math.round(major * 10 ** currencyExponent(currency));
}
