// The four numbers above the timeline. Item 5 of the 2026-09-15 rebrand.

import type { DayBusyBlock } from "./day-view-api.ts";

/**
 * **Derived from the same array the timeline draws, and that is the whole design.**
 *
 * The brief asked for cards "computed from the same queue data as the list", with a guard that the
 * numbers agree. The way to make that true is not to check it afterwards but to make a second
 * source impossible: this takes `day.busy` — the exact blocks the timeline renders — so a card and
 * a bar cannot disagree without the array itself being inconsistent with itself.
 *
 * A second endpoint returning counts would have been the obvious alternative and is the one that
 * rots: the day view polls every fifteen seconds, and two responses fetched a moment apart show a
 * total that does not match the bars under it for reasons nobody can reproduce.
 */
export interface DaySummary {
  /** Arrived and waiting to be seen — the queue as reception means it. */
  waiting: number;
  /** Every appointment occupying time today, whatever its status. */
  total: number;
  /** Past their slot and still not arrived. Needs an instant, which is why `now` is a parameter. */
  late: number;
  completed: number;
}

/** Statuses that mean "here, not yet seen". ARRIVED and WAITING are one thing to a receptionist. */
const WAITING_STATUSES = new Set(["ARRIVED", "WAITING"]);

/** Statuses that mean "has not turned up yet". Late is only meaningful for these. */
const NOT_ARRIVED_STATUSES = new Set(["BOOKED", "CONFIRMED"]);

/**
 * `now` is a parameter and never read from the clock inside.
 *
 * `CLAUDE.md`: anything whose output is called reproducible takes its reference point explicitly. A
 * `late` count computed from `Date.now()` in here is a number that cannot be tested without either
 * mocking time or writing a test that passes in the morning and fails after lunch — and the second
 * kind gets deleted rather than fixed.
 */
export function summariseDay(busy: readonly DayBusyBlock[], now: Date): DaySummary {
  let waiting = 0;
  let late = 0;
  let completed = 0;

  for (const block of busy) {
    if (WAITING_STATUSES.has(block.status)) waiting += 1;
    if (block.status === "COMPLETED") completed += 1;
    if (NOT_ARRIVED_STATUSES.has(block.status) && new Date(block.start).getTime() < now.getTime()) late += 1;
  }

  return { waiting, total: busy.length, late, completed };
}
