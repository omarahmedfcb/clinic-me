import {
  applyPattern,
  inferPattern,
  initialSettingsOpen,
  isOverride,
  nextOccurrence,
  oneOffBlockedWindows,
  type WorkingHoursPattern,
} from "../../../web/src/features/schedules/pattern.ts";
import type { ScheduleTemplate } from "../../../web/src/features/schedules/schedules-api.ts";

/**
 * The working-hours pattern, and the question the founder asked before it was built: **when the
 * unified hours change after per-day overrides exist, do the overrides survive?**
 *
 * They survive. The two failure modes are not symmetric — overwriting silently destroys hours a
 * human deliberately typed, and nobody notices until a patient is booked into an hour that no
 * longer exists; preserving leaves an admin briefly believing they changed every day when one did
 * not move, which the next glance corrects. So the rule is: **preserve, and say so before saving.**
 *
 * This spec lives in the API's test project because that is where the runner is, and it reaches
 * across into `apps/web`. `pattern.ts` is pure and imports only a type, so it loads standalone —
 * if that ever stops being true, this file fails loudly rather than the logic going untested.
 */

const PATTERN: WorkingHoursPattern = {
  startTime: "09:00",
  endTime: "17:00",
  validFrom: "2026-09-01",
  validTo: null,
  daysOff: [5, 6], // Friday and Saturday
};

const template = (over: Partial<ScheduleTemplate> & { weekday: number }): ScheduleTemplate => ({
  startTime: "09:00",
  endTime: "17:00",
  validFrom: "2026-09-01",
  validTo: null,
  breaks: [],
  ...over,
});

describe("working-hours pattern", () => {
  describe("generating the week", () => {
    it("creates one row per working day and none for the days off", () => {
      const { templates, workingDays } = applyPattern([], PATTERN, false);
      expect(workingDays).toEqual([0, 1, 2, 3, 4]);
      expect(templates.map((t) => t.weekday)).toEqual([0, 1, 2, 3, 4]);
      expect(templates.every((t) => t.startTime === "09:00" && t.endTime === "17:00")).toBe(true);
    });

    it("handles Friday-only, the other common Egyptian week", () => {
      const { workingDays } = applyPattern([], { ...PATTERN, daysOff: [5] }, false);
      expect(workingDays).toEqual([0, 1, 2, 3, 4, 6]);
    });

    it("removes a day that becomes a day off", () => {
      const existing = [template({ weekday: 4 }), template({ weekday: 0 })];
      const { templates } = applyPattern(existing, { ...PATTERN, daysOff: [4, 5, 6] }, false);
      expect(templates.map((t) => t.weekday)).toEqual([0, 1, 2, 3]);
    });
  });

  describe("overrides survive a pattern change — the founder's question", () => {
    /** The doctor whose Thursday ends at 18:00 instead of 21:00. */
    const withThursdayOverride = [
      template({ weekday: 0 }),
      template({ weekday: 4, startTime: "09:00", endTime: "18:00" }),
    ];

    it("keeps the overridden day's hours when the pattern changes", () => {
      const changed = { ...PATTERN, endTime: "21:00" };
      const { templates, preserved } = applyPattern(withThursdayOverride, changed, false);

      expect(preserved).toEqual([4]);
      expect(templates.find((t) => t.weekday === 4)?.endTime).toBe("18:00");
      expect(templates.find((t) => t.weekday === 0)?.endTime).toBe("21:00");
    });

    /**
     * The half that makes preserving safe rather than merely quiet: the caller is told which days
     * it left alone, so the screen can say so before the save rather than after the surprise.
     */
    it("reports every preserved day so the screen can warn before saving", () => {
      const many = [
        template({ weekday: 0 }),
        template({ weekday: 2, endTime: "13:00" }),
        template({ weekday: 4, endTime: "18:00" }),
      ];
      const { preserved } = applyPattern(many, { ...PATTERN, endTime: "21:00" }, false);
      expect(preserved).toEqual([2, 4]);
    });

    it("overwrites them when the user explicitly asks to reset", () => {
      const changed = { ...PATTERN, endTime: "21:00" };
      const { templates, preserved } = applyPattern(withThursdayOverride, changed, true);

      expect(preserved).toEqual([]);
      expect(templates.every((t) => t.endTime === "21:00")).toBe(true);
    });

    /**
     * A break hangs off a template and belongs to the day, not to the pattern. Regenerating them
     * would silently delete a clinic's lunch hour every time somebody adjusted a closing time.
     */
    it("never touches breaks", () => {
      const withBreak = [
        template({ weekday: 0, breaks: [{ startTime: "13:00", endTime: "14:00", label: "غداء" }] }),
      ];
      const { templates } = applyPattern(withBreak, { ...PATTERN, endTime: "21:00" }, false);
      expect(templates[0]?.breaks).toEqual([{ startTime: "13:00", endTime: "14:00", label: "غداء" }]);
    });

    /**
     * Validity is a property of the arrangement, not of one day — a day left behind on an old
     * window is a silent gap in availability, which is worse than a visibly different closing time.
     */
    it("applies the validity period even to preserved days", () => {
      const changed = { ...PATTERN, validFrom: "2026-10-01", validTo: "2026-12-31", endTime: "21:00" };
      const { templates } = applyPattern(withThursdayOverride, changed, false);

      expect(templates.every((t) => t.validFrom === "2026-10-01" && t.validTo === "2026-12-31")).toBe(true);
      expect(templates.find((t) => t.weekday === 4)?.endTime).toBe("18:00");
    });
  });

  describe("inferring the pattern from stored rows", () => {
    it("defaults an empty schedule to Sunday–Thursday", () => {
      const inferred = inferPattern([], "2026-09-01");
      expect(inferred.daysOff).toEqual([5, 6]);
      expect(inferred.validFrom).toBe("2026-09-01");
    });

    it("takes the hours the most days share, not the first day's", () => {
      const rows = [
        template({ weekday: 0, endTime: "18:00" }), // the odd one out, and the earliest
        template({ weekday: 1 }),
        template({ weekday: 2 }),
        template({ weekday: 3 }),
      ];
      const inferred = inferPattern(rows, "2026-09-01");
      expect(inferred.endTime).toBe("17:00");
      expect(isOverride(rows[0]!, inferred)).toBe(true);
      expect(isOverride(rows[1]!, inferred)).toBe(false);
    });

    it("round-trips: inferring then applying changes nothing", () => {
      const rows = [template({ weekday: 0 }), template({ weekday: 1 }), template({ weekday: 4, endTime: "18:00" })];
      const inferred = inferPattern(rows, "2026-09-01");
      const { templates, preserved } = applyPattern(rows, inferred, false);

      expect(preserved).toEqual([4]);
      expect(templates.map((t) => `${t.weekday}:${t.startTime}-${t.endTime}`)).toEqual([
        "0:09:00-17:00",
        "1:09:00-17:00",
        "4:09:00-18:00",
      ]);
    });

    it("is deterministic when two sets of hours are equally common", () => {
      const rows = [template({ weekday: 0, endTime: "18:00" }), template({ weekday: 3 })];
      expect(inferPattern(rows, "2026-09-01").endTime).toBe("18:00"); // ties go to the earliest day
    });
  });
});

/**
 * The one-off half of the per-day question.
 *
 * A row that reads "this day runs 09:00–18:00" against a 09:00–21:00 pattern is, as a one-off, the
 * absence of 18:00–21:00 on one date. These are the windows that become `BLOCKED` exceptions.
 */
describe("one-off windows", () => {
  const pattern: WorkingHoursPattern = {
    startTime: "09:00",
    endTime: "21:00",
    validFrom: "2026-09-01",
    validTo: null,
    daysOff: [5, 6],
  };

  it("blocks the evening when the day ends early", () => {
    expect(oneOffBlockedWindows(pattern, { startTime: "09:00", endTime: "18:00" })).toEqual([
      { startTime: "18:00", endTime: "21:00" },
    ]);
  });

  it("blocks the morning when the day starts late", () => {
    expect(oneOffBlockedWindows(pattern, { startTime: "11:00", endTime: "21:00" })).toEqual([
      { startTime: "09:00", endTime: "11:00" },
    ]);
  });

  /**
   * Two windows, not one spanning them — a single 09:00–21:00 block would close the day the doctor
   * is actually working.
   */
  it("returns two windows when both ends move", () => {
    expect(oneOffBlockedWindows(pattern, { startTime: "11:00", endTime: "18:00" })).toEqual([
      { startTime: "09:00", endTime: "11:00" },
      { startTime: "18:00", endTime: "21:00" },
    ]);
  });

  it("returns nothing when the day is unchanged", () => {
    expect(oneOffBlockedWindows(pattern, { startTime: "09:00", endTime: "21:00" })).toEqual([]);
  });

  /** Extra hours are EXTRA_AVAILABILITY, a different thing. Guessing at that would be wrong. */
  it("returns nothing when the day is longer than the pattern", () => {
    expect(oneOffBlockedWindows(pattern, { startTime: "08:00", endTime: "22:00" })).toEqual([]);
  });
});

describe("next occurrence of a weekday", () => {
  it("returns the same date when it is already that weekday", () => {
    // 2026-09-03 is a Thursday (getDay 4).
    expect(nextOccurrence(4, "2026-09-03")).toBe("2026-09-03");
  });

  it("finds the next one otherwise", () => {
    expect(nextOccurrence(4, "2026-09-04")).toBe("2026-09-10");
    expect(nextOccurrence(0, "2026-09-03")).toBe("2026-09-06");
  });
});

/**
 * When the working-hours settings start open.
 *
 * Tested as a predicate rather than by screenshotting the page, because the rule is a rule and a
 * screenshot proves one instance of it. The condition the founder set is the first-time case: a
 * doctor with no saved schedule must land with the settings already open, since that is the one
 * moment the screen has to explain where hours are set.
 */
describe("settings panel opens for a first-time doctor", () => {
  it("opens when the doctor has no saved schedule", () => {
    expect(initialSettingsOpen(null, 0)).toBe(true);
  });

  it("stays collapsed when a schedule already exists", () => {
    expect(initialSettingsOpen(null, 5)).toBe(false);
  });

  /** A refresh after saving must not slam the panel shut under someone who opened it. */
  it("keeps an explicit choice, in both directions", () => {
    expect(initialSettingsOpen(true, 5)).toBe(true);
    expect(initialSettingsOpen(false, 0)).toBe(false);
  });
});
