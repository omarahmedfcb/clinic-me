import { planDay } from "./day-plan.ts";
import type { BusyBlock, CalendarDate, DayPlanInput } from "./types.ts";
import { offsetMinutesAt } from "./zoned-time.ts";

/**
 * The reception day view — PHASE-2.md §1 and Q25.
 *
 * `generateSlots()` answers "what can I book?" and returns only bookable time. A calendar needs
 * the opposite as well: the shape of the working day, and what is filling it. Returning only free
 * slots would leave the day view unable to draw an appointment, and returning slots-with-reasons
 * from `generateSlots()` would put render-only data into the AI agent's list and mint booking
 * tokens for time that is not bookable.
 *
 * So: two functions, **one** computation. Both are thin wrappers over `planDay()`, and neither
 * can drift from the other, because there is nothing to drift — the only availability logic in
 * this module lives in the function they share.
 */
export interface DayDescription {
  date: CalendarDate;
  doctorId: string;
  /** Working sessions after breaks and blocks. Empty means the doctor does not work this day. */
  working: { start: Date; end: Date; utcOffsetMinutes: number }[];
  /** Appointments occupying time, buffer included, ordered by start. */
  busy: BusyBlock[];
  /** Gaps inside the working sessions. What `generateSlots()` cuts slots from. */
  free: { start: Date; end: Date }[];
  /**
   * Breaks and BLOCKED/HOLIDAY time inside the clinic's open hours.
   *
   * Returned so the calendar can draw *why* a stretch is empty. Without it an empty span is
   * ambiguous — available and closed render identically — and that ambiguity is on the screen a
   * receptionist reads at a glance.
   */
  unavailable: { start: Date; end: Date }[];
  /**
   * True when the day has working time but none of it is free.
   *
   * A distinction the reception screen has to make and an empty slot list cannot: "the doctor is
   * fully booked" and "the doctor does not work Fridays" produce the same empty availability and
   * need different words on screen. It is derived here rather than left to the caller so that
   * every caller derives it the same way.
   */
  fullyBooked: boolean;
}

export function describeDay(input: DayPlanInput): DayDescription {
  const { working, busy, free, unavailable } = planDay(input);

  return {
    date: input.date,
    doctorId: input.doctorId,
    working: working.map((w) => ({
      start: new Date(w.start),
      end: new Date(w.end),
      // Carried for the same reason a slot carries it: on the night the clocks go back a session
      // spans two offsets, and a header rendering local time alone shows an hour that repeats.
      utcOffsetMinutes: offsetMinutesAt(new Date(w.start), input.timezone),
    })),
    busy,
    free: free.map((f) => ({ start: new Date(f.start), end: new Date(f.end) })),
    unavailable: unavailable.map((u) => ({ start: new Date(u.start), end: new Date(u.end) })),
    fullyBooked: working.length > 0 && free.length === 0,
  };
}
