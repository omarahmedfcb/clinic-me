import { describe, expect, test } from "vitest";
import { summariseDay } from "./day-kpis.ts";
import type { DayBusyBlock } from "./day-view-api.ts";

/**
 * **The guard the brief names: the card numbers equal the list counts.**
 *
 * `summariseDay` takes the same `day.busy` array the timeline draws its bars from, so the way to
 * assert agreement is to count that array independently here and require the same answers. If the
 * cards ever grew their own endpoint, this is what would stop it.
 */

const NOW = new Date("2026-09-15T12:00:00.000Z");

const block = (status: string, start: string): DayBusyBlock =>
  ({ start, end: start, appointmentId: `a-${status}-${start}`, status }) as DayBusyBlock;

const DAY: DayBusyBlock[] = [
  block("BOOKED", "2026-09-15T09:00:00.000Z"), // past, never arrived -> late
  block("CONFIRMED", "2026-09-15T10:30:00.000Z"), // past, never arrived -> late
  block("BOOKED", "2026-09-15T15:00:00.000Z"), // still to come -> not late
  block("ARRIVED", "2026-09-15T11:00:00.000Z"),
  block("WAITING", "2026-09-15T11:30:00.000Z"),
  block("IN_CONSULTATION", "2026-09-15T11:45:00.000Z"),
  block("PAUSED", "2026-09-15T11:50:00.000Z"),
  block("COMPLETED", "2026-09-15T08:00:00.000Z"),
  block("COMPLETED", "2026-09-15T08:30:00.000Z"),
];

describe("the day's four numbers", () => {
  test("each card equals an independent count of the same array", () => {
    const summary = summariseDay(DAY, NOW);

    // Counted here from the array itself, not copied from the implementation. The two have to
    // agree for a reason, and the reason is that they read the same list.
    expect(summary).toEqual({
      waiting: DAY.filter((b) => b.status === "ARRIVED" || b.status === "WAITING").length,
      total: DAY.length,
      late: DAY.filter(
        (b) => (b.status === "BOOKED" || b.status === "CONFIRMED") && new Date(b.start) < NOW,
      ).length,
      completed: DAY.filter((b) => b.status === "COMPLETED").length,
    });

    // And the literal values, so a change to both sides at once still has to be deliberate.
    expect(summary).toEqual({ waiting: 2, total: 9, late: 2, completed: 2 });
  });

  test("the total is every occupying block, not a subset of the statuses", () => {
    // CANCELLED and NO_SHOW release their slot and never reach `busy`, so "total" is simply the
    // length — and stating it here stops somebody "fixing" it into a filtered count later.
    expect(summariseDay(DAY, NOW).total).toBe(DAY.length);
  });

  /**
   * `late` is computed against an instant that is passed in.
   *
   * The same day, read at 08:00, has nobody late. Read at 16:00 it has three. A function that read
   * the clock could not be asked either question, which is the whole of `CLAUDE.md`'s rule about
   * anything called reproducible.
   */
  test("late depends on the instant it is asked about, and the instant is a parameter", () => {
    const readings = ["2026-09-15T07:00:00.000Z", "2026-09-15T12:00:00.000Z", "2026-09-15T16:00:00.000Z"].map(
      (at) => summariseDay(DAY, new Date(at)).late,
    );
    expect(readings).toEqual([0, 2, 3]);
  });

  test("an empty day is four zeroes, not a crash", () => {
    expect(summariseDay([], NOW)).toEqual({ waiting: 0, total: 0, late: 0, completed: 0 });
  });

  test("a patient who arrived late is not counted late — they are here", () => {
    // The distinction the card is for: "late" means nobody has turned up, and reception needs to
    // chase. Somebody who arrived at 11:00 for a 09:00 slot is waiting, not missing.
    const arrivedLate = [block("ARRIVED", "2026-09-15T09:00:00.000Z")];
    expect(summariseDay(arrivedLate, NOW)).toMatchObject({ late: 0, waiting: 1 });
  });
});
