import type { ScheduleTemplate } from "./schedules-api.ts";

/**
 * Turning one working-hours entry into the seven-row template set the schema stores.
 *
 * **The schema is right and does not change.** One row per weekday is correct, because Wednesday
 * genuinely can differ from Tuesday. What changes is that a human enters the common case once —
 * hours, validity, days off — and this fills the rows.
 *
 * ## It is a weekly pattern with a validity period, not a monthly schedule
 *
 * Nothing here is per-month. The pattern repeats every week until its `validTo`, or forever if
 * that is null. Naming it "monthly" would leave the first person who asks "what happens in month
 * two?" with no answer, because the question would not apply.
 *
 * ## Overrides survive a pattern change
 *
 * The two failure modes are not symmetric. Overwriting silently destroys hours a human deliberately
 * typed — the doctor whose Thursday ends at 18:00 — and nobody notices until a patient is booked
 * into the hour that no longer exists. Preserving leaves an admin briefly believing they changed
 * every day when one did not move, which the next glance at the screen corrects.
 *
 * So overrides are kept, and `applyPattern` reports exactly which days it left alone so the screen
 * can say so *before* the save. Resetting them is available and explicit, never a side effect.
 */

export interface WorkingHoursPattern {
  startTime: string;
  endTime: string;
  validFrom: string;
  validTo: string | null;
  /** JS `getDay()` values that are NOT worked. Friday (5) is the common case in Egypt. */
  daysOff: number[];
}

export const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/** A row differs from the pattern in its hours — someone typed it deliberately. */
export function isOverride(template: ScheduleTemplate, pattern: WorkingHoursPattern): boolean {
  return template.startTime !== pattern.startTime || template.endTime !== pattern.endTime;
}

export interface PatternApplication {
  templates: ScheduleTemplate[];
  /** Weekdays whose hours were left alone because they differ from the pattern. */
  preserved: number[];
  /** Weekdays that will exist after this is applied. */
  workingDays: number[];
}

/**
 * Apply a pattern to an existing template set.
 *
 * Days off are removed. Working days that do not exist are created from the pattern. Working days
 * that exist keep their **breaks** always, and keep their **hours** unless `resetOverrides` is set
 * or they already match the pattern.
 *
 * Breaks are never touched, because a break hangs off a template and belongs to the day rather than
 * to the pattern — regenerating them would silently delete a clinic's lunch hour every time
 * somebody adjusted a closing time.
 */
export function applyPattern(
  existing: ScheduleTemplate[],
  pattern: WorkingHoursPattern,
  resetOverrides: boolean,
): PatternApplication {
  // An override is a day that differed from the pattern **as it was**, not one that differs from
  // the pattern being applied. Comparing against the incoming pattern was the first version of
  // this and it is exactly backwards: change the closing time and every day looks deliberately
  // different, so every day is preserved and nothing ever updates. The previous pattern is
  // inferred from the rows themselves, which is also how the form is populated on load.
  const previous = inferPattern(existing, pattern.validFrom);
  const off = new Set(pattern.daysOff);
  const workingDays = ALL_WEEKDAYS.filter((day) => !off.has(day));
  const byWeekday = new Map(existing.map((template) => [template.weekday, template]));

  const preserved: number[] = [];
  const templates = workingDays.map((weekday) => {
    const current = byWeekday.get(weekday);

    if (current === undefined) {
      return {
        weekday,
        startTime: pattern.startTime,
        endTime: pattern.endTime,
        validFrom: pattern.validFrom,
        validTo: pattern.validTo,
        breaks: [],
      };
    }

    const keepHours = !resetOverrides && isOverride(current, previous);
    if (keepHours) preserved.push(weekday);

    return {
      ...current,
      startTime: keepHours ? current.startTime : pattern.startTime,
      endTime: keepHours ? current.endTime : pattern.endTime,
      // Validity always follows the pattern: it is a property of the arrangement as a whole, not
      // of one day, and a day left on an old validity window is a silent gap in availability.
      validFrom: pattern.validFrom,
      validTo: pattern.validTo,
    };
  });

  return { templates, preserved, workingDays: [...workingDays] };
}

/**
 * The pattern implied by an existing template set, for populating the form on load.
 *
 * The hours are the ones the **most** working days share — so a doctor with four days at 09:00 and
 * one at 10:00 sees 09:00 as the pattern and the odd day marked as an override, which is what a
 * human means by "my hours". Ties fall to the earliest weekday, deterministically.
 */
export function inferPattern(templates: ScheduleTemplate[], today: string): WorkingHoursPattern {
  const worked = new Set(templates.map((template) => template.weekday));
  const daysOff = ALL_WEEKDAYS.filter((day) => !worked.has(day));

  if (templates.length === 0) {
    // Sunday to Thursday, the ordinary Egyptian working week, with Friday and Saturday off.
    return { startTime: "09:00", endTime: "17:00", validFrom: today, validTo: null, daysOff: [5, 6] };
  }

  const counts = new Map<string, { n: number; first: number }>();
  for (const template of [...templates].sort((a, b) => a.weekday - b.weekday)) {
    const key = `${template.startTime}|${template.endTime}`;
    const seen = counts.get(key);
    if (seen === undefined) counts.set(key, { n: 1, first: template.weekday });
    else seen.n += 1;
  }

  let bestKey = "";
  let best = { n: -1, first: 99 };
  for (const [key, value] of counts) {
    if (value.n > best.n || (value.n === best.n && value.first < best.first)) {
      bestKey = key;
      best = value;
    }
  }

  const [startTime, endTime] = bestKey.split("|") as [string, string];
  const earliest = templates.reduce((a, b) => (a.validFrom <= b.validFrom ? a : b));

  return {
    startTime,
    endTime,
    validFrom: earliest.validFrom,
    validTo: earliest.validTo,
    daysOff: [...daysOff],
  };
}

/**
 * The windows a one-off change removes from a day.
 *
 * A per-day row says "this day runs 09:00–18:00" while the pattern says 09:00–21:00. As a
 * **recurring** change that is a template row with different hours. As a **one-off** it is the
 * absence of 18:00–21:00 on one date — which is a `BLOCKED` exception, and is what the exceptions
 * list already stores.
 *
 * Both ends can move, so this returns up to two windows: the morning the doctor is not yet in, and
 * the evening they have left. Returning them rather than one merged window matters because a day
 * shortened at both ends is two separate absences, and a single window spanning the working hours
 * between them would block the day entirely.
 *
 * Returns an empty array when the day is unchanged, and — deliberately — when the day is *longer*
 * than the pattern. Extra hours on one date are `EXTRA_AVAILABILITY`, a different thing, and
 * silently converting them here would be this function guessing at intent.
 */
export function oneOffBlockedWindows(
  pattern: WorkingHoursPattern,
  day: { startTime: string; endTime: string },
): { startTime: string; endTime: string }[] {
  const windows: { startTime: string; endTime: string }[] = [];
  if (day.startTime > pattern.startTime) {
    windows.push({ startTime: pattern.startTime, endTime: day.startTime });
  }
  if (day.endTime < pattern.endTime) {
    windows.push({ startTime: day.endTime, endTime: pattern.endTime });
  }
  return windows;
}

/** The next occurrence of `weekday` on or after `from`, as `YYYY-MM-DD`. */
export function nextOccurrence(weekday: number, from: string): string {
  const at = new Date(`${from}T12:00:00Z`);
  const shift = (weekday - at.getUTCDay() + 7) % 7;
  at.setUTCDate(at.getUTCDate() + shift);
  return at.toISOString().slice(0, 10);
}

/**
 * Should the working-hours settings start open?
 *
 * **Open when the doctor has no saved schedule.** That is the one moment the screen has to explain
 * itself: a first-time doctor must not have to find a button to discover where hours are set. Once
 * a schedule exists the settings are something you revisit occasionally, and the day-to-day work is
 * the week and the unavailable times, so they collapse.
 *
 * `previous` is the panel's current state and wins when it is not null, so a refresh after saving
 * does not slam the panel shut under someone who deliberately opened it. It is reset to null when
 * the selected doctor changes, so the next doctor is judged on their own rows.
 */
export function initialSettingsOpen(previous: boolean | null, savedTemplateCount: number): boolean {
  return previous ?? savedTemplateCount === 0;
}
