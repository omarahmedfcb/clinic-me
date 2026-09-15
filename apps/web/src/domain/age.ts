/**
 * A patient's age in whole years, or `null` when their date of birth was never recorded.
 *
 * ## Why this is a function and not `Date.now() - dob` inline
 *
 * `ClinicalSection` computes age as
 * `Math.floor((Date.now() - Date.parse(dob)) / 31_557_600_000)` — dividing by an average Julian
 * year. **That arithmetic is not wrong, and it was checked rather than assumed:** every birth date
 * from 1930 to today, on three days of each month, gives the same answer as calendar arithmetic.
 * The Julian year is 365.25 days against the Gregorian 365.2425, a drift of one day per 133 years,
 * so it cannot slip within a human lifespan.
 *
 * The reason to replace it is the two things around the arithmetic rather than the arithmetic
 * itself: it reads the clock inside a render, so no boundary case can be tested; and it produces
 * `NaN` for a null date of birth, which is then rendered. Calendar arithmetic is used here anyway
 * because it is the one a reader can check by eye, not because the other is broken.
 *
 * ## `null` is a real answer and must reach the screen as one
 *
 * `patients.date_of_birth` is nullable and plenty of Egyptian walk-in registrations have no date of
 * birth at all. The founder's ruling of 2026-09-05: *"show غير مسجل, never a blank or a zero"*.
 * Both failure modes are worse than the truth — a blank reads as a rendering fault, and a zero
 * reads as a newborn.
 *
 * So this returns `null` rather than `0` or `NaN`, and the caller is forced by the type to decide
 * what to print.
 *
 * `now` is a parameter, not a clock read, so the boundary cases are testable: a birthday today, a
 * birthday tomorrow, and 29 February.
 */
export function ageInYears(dateOfBirth: string | null, now: Date): number | null {
  if (dateOfBirth === null || dateOfBirth.trim() === "") return null;

  // `YYYY-MM-DD` from a Postgres DATE, or a full ISO instant. Only the calendar part is meaningful:
  // a birth date has no time of day, and parsing one as UTC midnight then reading local components
  // would shift it a day west of Greenwich.
  const [year, month, day] = dateOfBirth.slice(0, 10).split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  let age = now.getFullYear() - year;

  // Has this year's birthday happened yet? Comparing month and day directly rather than building a
  // Date avoids the 29 February problem: in a non-leap year there is no 29 February to construct,
  // and `new Date(2027, 1, 29)` silently becomes 1 March.
  const monthNow = now.getMonth() + 1;
  const dayNow = now.getDate();
  if (monthNow < month || (monthNow === month && dayNow < day)) age -= 1;

  // A future date of birth is data entry gone wrong, not a negative age. Null says "unusable",
  // which is what the screen should print, rather than "-2".
  return age < 0 ? null : age;
}
