// Date of birth as three selects — day, month, year. Q31 as amended 2026-09-09.
// Typed `dd/mm/yyyy` before that; a select cannot produce 31/02, and a receptionist cannot mistype it.

export type BirthDateProblem = "INCOMPLETE" | "IMPOSSIBLE" | "FUTURE";

export interface BirthDateParts {
  day: string;
  month: string;
  year: string;
}

export const EMPTY_BIRTH_DATE: BirthDateParts = { day: "", month: "", year: "" };

export type BirthDate = { ok: true; iso: string } | { ok: false; problem: BirthDateProblem };

/**
 * Years, newest first — a birthday is far more often recent than a century ago, and a list that
 * starts at 1906 makes the common case the longest scroll.
 *
 * `today` is a parameter and never the clock: the top of this list is "the current year", which is a
 * claim about an instant, and the rule here is that such a claim is passed in so a test can move it.
 */
export function birthYearOptions(today: Date, span = 120): string[] {
  const current = today.getFullYear();
  return Array.from({ length: span + 1 }, (_, index) => String(current - index));
}

export const MONTH_NUMBERS = Array.from({ length: 12 }, (_, index) => String(index + 1));

/**
 * How many days that month has, so 31 is not offered for April and 29 only in a leap year.
 *
 * With no year chosen yet, February is given 29: offering 28 would refuse a real birthday from a
 * leap year the moment the year is picked, and the parse below is what finally decides.
 */
export function daysInMonth(month: string, year: string): number {
  const monthNumber = Number(month);
  if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) return 31;
  // `year === ""` and not `Number.isInteger(Number(year))`: `Number("")` is 0, which is an integer,
  // so the obvious guard silently asked for February of year 0. Caught by the spec, not by review.
  if (monthNumber === 2 && year === "") return 29;
  const yearNumber = Number(year);
  if (monthNumber === 2 && !Number.isInteger(yearNumber)) return 29;
  return new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();
}

export function birthDayOptions(month: string, year: string): string[] {
  return Array.from({ length: daysInMonth(month, year) }, (_, index) => String(index + 1));
}

/**
 * The three parts as an ISO calendar day, or why they are not one.
 *
 * Built in UTC and read back, so an impossible combination — 31 kept from a previous month after
 * switching to February — fails rather than rolling forward into March.
 */
export function isoFromParts(parts: BirthDateParts, today: Date): BirthDate {
  const { day, month, year } = parts;
  if (day === "" || month === "" || year === "") return { ok: false, problem: "INCOMPLETE" };

  const [d, m, y] = [Number(day), Number(month), Number(year)];
  const date = new Date(Date.UTC(y, m - 1, d));
  const real =
    date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  if (!real) return { ok: false, problem: "IMPOSSIBLE" };

  // Past years only (Q31). Today itself is allowed: a newborn registered on the day is ordinary.
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  if (date.getTime() > todayUtc) return { ok: false, problem: "FUTURE" };

  return { ok: true, iso: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}

/** ISO back to three parts, so a national ID can fill all three and a person can then correct them. */
export function partsFromIso(iso: string | null): BirthDateParts {
  if (iso === null || iso === "") return EMPTY_BIRTH_DATE;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (match === null) return EMPTY_BIRTH_DATE;
  return {
    day: String(Number(match[3])),
    month: String(Number(match[2])),
    year: match[1] as string,
  };
}
