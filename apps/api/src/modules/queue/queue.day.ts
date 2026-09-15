import type { TransactionClient } from "../../prisma/with-tenant.ts";
import { loadDayInput } from "../appointments/appointments.fetch.ts";
import { planDay } from "../appointments/domain/day-plan.ts";
import { resolveBoundary } from "../appointments/domain/zoned-time.ts";

/**
 * The instants that bound one clinic day — `PHASE-3.md` Q12.
 *
 * ## Why this is not `date_trunc('day', scheduled_start)`
 *
 * Q12 states it as a rule rather than leaving it to fall out of the implementation: **the queue
 * and the day view answer "which day is this appointment on" with the same code.** A clinic
 * running Thursday 22:00 to 02:00 has patients seen at 00:30 who belong to Thursday. Truncating on
 * the calendar day puts them on Friday, and they vanish from the screen they are standing in front
 * of.
 *
 * So the day's end comes from `planDay()` — the same function `describeDay()` and
 * `generateSlots()` are both built on — rather than from a second notion of a day invented here.
 * There is nothing to drift, because there is no second implementation.
 *
 * ## The all-doctors case, which the day view does not have
 *
 * `describeDay()` is per doctor. The queue is per clinic (Q11), so the clinic's day is the
 * **union** of its doctors' working windows for that date: the earliest start and the latest end.
 * One doctor's Thursday night clinic extends the whole clinic's Thursday, which is correct — the
 * queue is one screen and a patient on it belongs to the day their own doctor was working.
 *
 * ## Cost, stated rather than assumed
 *
 * This runs `planDay()` once per doctor, and the queue polls every five seconds (Q1). For a clinic
 * with a handful of doctors that is a few small reads against indexed tables. It is **not**
 * measured, and `PHASE-3.md` §5 asks for `EXPLAIN` against seeded data before any index is added;
 * the same discipline applies here before this is called cheap.
 *
 * When no doctor works that date, there is no working window to take a union of, and the day falls
 * back to local midnight-to-midnight. That is the honest answer: a walk-in registered on a closed
 * day still has to appear somewhere, and the calendar day is the only meaning left.
 */
export async function clinicDayBounds(
  tx: TransactionClient,
  date: string,
  timezone: string,
): Promise<{ dayStart: Date; dayEnd: Date }> {
  const doctors = await tx.doctor.findMany({ where: { isActive: true }, select: { id: true } });

  let earliest: number | null = null;
  let latest: number | null = null;

  for (const doctor of doctors) {
    const { working } = planDay(await loadDayInput(tx, doctor.id, date, timezone));
    for (const window of working) {
      earliest = earliest === null ? window.start : Math.min(earliest, window.start);
      latest = latest === null ? window.end : Math.max(latest, window.end);
    }
  }

  // The calendar day, used as the fallback and as the floor/ceiling below. `resolveBoundary` is
  // the same function `planDay()` uses for its own windows, so a DST boundary is handled once.
  const midnight = resolveBoundary(date, 0, timezone, "start");
  const nextMidnight = resolveBoundary(date, 1440, timezone, "end");

  if (earliest === null || latest === null) {
    return { dayStart: midnight, dayEnd: nextMidnight };
  }

  // Never narrower than the calendar day. A clinic that opens at 09:00 still expects a walk-in
  // registered at 08:30 to be on today's queue, and an appointment booked for a time no doctor
  // works is exactly the kind of row reception needs to see rather than lose.
  return {
    dayStart: new Date(Math.min(earliest, midnight.getTime())),
    dayEnd: new Date(Math.max(latest, nextMidnight.getTime())),
  };
}
