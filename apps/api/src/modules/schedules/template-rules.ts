/**
 * Validation rules for a set of schedule templates. Pure — no I/O, no clock, no timezone.
 *
 * These live apart from `schedules.service.ts` because they are the half that can be tested
 * without a database, and because the service was over the ~300-line limit with them inline.
 *
 * ## Strict here, tolerant in the engine
 *
 * PHASE-2.md Q6/Q10: the write path rejects an overlapping or empty template; the slot engine
 * unions whatever it is given. That asymmetry is deliberate. Rejection belongs at the moment a
 * human is present to fix it. A pure function that threw on stored data would make a doctor's
 * whole day un-bookable at 9am because of one bad row entered last month — and the person who
 * could fix it is not the person looking at the empty calendar.
 */

export interface TemplateWindow {
  weekday: number;
  startTime: string;
  endTime: string;
  validFrom: string;
  validTo: string | null;
}

const minutes = (wallClock: string): number => {
  const [h, m] = wallClock.split(":").map(Number) as [number, number];
  return h * 60 + m;
};

/**
 * End before start means a session crossing midnight, which is valid (Q8) — so the window is
 * extended into the next day rather than rejected. Only a zero-length window is meaningless, and
 * that is caught separately by `findEmptyWindow` and by the database's `CHECK (start <> end)`.
 */
function span(template: TemplateWindow): { start: number; end: number } {
  const start = minutes(template.startTime);
  const raw = minutes(template.endTime);
  return { start, end: raw <= start ? raw + 1440 : raw };
}

/** Both validity bounds inclusive (Q7), so windows that merely touch do overlap. */
function validityOverlaps(a: TemplateWindow, b: TemplateWindow): boolean {
  return a.validFrom <= (b.validTo ?? "9999-12-31") && b.validFrom <= (a.validTo ?? "9999-12-31");
}

/** A human-readable description of the first overlap found, or `null` if the set is clean. */
/** The two clashing windows and the day they clash on, or null. Facts, not a sentence. */
export function findOverlap(
  templates: readonly TemplateWindow[],
): { weekday: number; windows: string[] } | null {
  for (let i = 0; i < templates.length; i += 1) {
    for (let j = i + 1; j < templates.length; j += 1) {
      const a = templates[i]!;
      const b = templates[j]!;
      if (a.weekday !== b.weekday) continue;
      if (!validityOverlaps(a, b)) continue;

      const spanA = span(a);
      const spanB = span(b);
      // Half-open: a template ending exactly when another starts is adjacent, not overlapping.
      if (spanA.start < spanB.end && spanB.start < spanA.end) {
        return {
          weekday: a.weekday,
          windows: [`${a.startTime}-${a.endTime}`, `${b.startTime}-${b.endTime}`],
        };
      }
    }
  }
  return null;
}

/** A template covering no time at all. Mirrors `schedule_templates_window_not_empty`. */
/** The zero-length window, or null. A window whose end precedes its start crosses midnight and is valid. */
export function findEmptyWindow(
  templates: readonly TemplateWindow[],
): { windows: string[] } | null {
  for (const template of templates) {
    if (template.startTime === template.endTime) {
      return { windows: [`${template.startTime}-${template.endTime}`] };
    }
  }
  return null;
}
