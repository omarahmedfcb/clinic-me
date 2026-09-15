import { planDay } from "./day-plan.ts";
import type { GenerateSlotsInput, Slot } from "./types.ts";
import { offsetMinutesAt } from "./zoned-time.ts";

/**
 * Bookable slots for one doctor on one day. Pure, deterministic, zero I/O — PHASE-2.md §7.
 *
 * Steps 1–8 are `planDay()`, shared with `describeDay()` so the calendar and the booking flow
 * cannot disagree (Q25). This function is steps 9 and 10: cut the free time into slots, and drop
 * the ones too soon to offer.
 *
 * Because `planDay()` returns instants, the two DST hazards are handled by not being special
 * cases at all. Stepping through real time cannot land inside a spring-forward gap, because those
 * instants do not exist; and it covers a fall-back hour twice, because those instants both do.
 */
export function generateSlots(input: GenerateSlotsInput): Slot[] {
  const { timezone, date, doctorId, granularityMinutes, service, leadMinutes, now } = input;

  // Defensive rather than validating: the engine is handed whatever the database holds, and a
  // pure function that throws would make a doctor's whole day un-bookable over one bad row. The
  // write path rejects these (services_buffer_minutes_sane, tenants_slot_granularity_sane).
  if (granularityMinutes <= 0 || service.durationMinutes <= 0) return [];

  const { free } = planDay(input);
  const durationMs = service.durationMinutes * 60_000;
  const stepMs = granularityMinutes * 60_000;

  // Q21 folded into Q22: "in the past" is not a separate rule, it is the lead time with staff at
  // zero. One boundary instead of two places for it to be wrong.
  const earliest = now.getTime() + leadMinutes * 60_000;

  const slots: Slot[] = [];
  for (const window of free) {
    // Q19: the grid anchors to the window start, not to the hour. A window opening at 09:07
    // offers 09:07; hour-anchoring silently discards the first fragment of every odd window.
    for (let start = window.start; start + durationMs <= window.end; start += stepMs) {
      if (start <= earliest) continue;
      const at = new Date(start);
      slots.push({
        doctorId,
        start: at,
        end: new Date(start + durationMs),
        utcOffsetMinutes: offsetMinutesAt(at, timezone),
        sessionDate: date,
      });
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}
