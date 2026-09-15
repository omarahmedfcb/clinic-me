import { subtract, union, type Interval } from "./interval.ts";
import { engineOccupies, occupiedFootprint } from "./occupancy.ts";
import type {
  DayPlan,
  DayPlanInput,
  ScheduleBreakRow,
  ScheduleExceptionRow,
  ScheduleTemplateRow,
  WallClock,
} from "./types.ts";
import { addDays, resolveBoundary, weekdayOf } from "./zoned-time.ts";

/**
 * Steps 1–8 of PHASE-2.md §7 — everything up to, but not including, cutting slots.
 *
 * **This exists so that `generateSlots()` and `describeDay()` are the same computation.** PHASE-2
 * Q25: a day view that worked out availability by its own route is how the calendar and the
 * booking flow end up disagreeing, and when they do there is no way to tell which one is wrong.
 * The two public functions differ only in what they do with the result of this one.
 *
 * The pipeline is in two halves and the seam is deliberate. Steps 1–6 are arithmetic on **wall
 * clock** and cannot fail: a template says 22:00 and that means twenty-two o'clock whatever the
 * offset does that night. Steps 7–8 work in **instants**. Concentrating every timezone hazard in
 * the single conversion between them is what makes the DST cases testable in one place instead of
 * scattered through the whole function.
 */
export function planDay(input: DayPlanInput): DayPlan {
  const { timezone, date, doctorId } = input;

  // Q27: sort every input before use. Prisma returns rows in whatever order Postgres gives, which
  // is stable in practice and guaranteed nowhere, and this claims to be deterministic.
  const templates = [...input.templates].sort(byId);
  const breaks = [...input.breaks].sort(byId);
  const exceptions = [...input.exceptions].sort(byId);
  const appointments = [...input.existingAppointments].sort(byId);

  // Steps 1-3. Only sessions anchored to `date` survive (step 6, Q8b) — which is what lets one
  // BLOCKED row on Thursday close the whole Thursday night clinic, tail included. The previous
  // day's templates still matter to the *service's fetch*, because a session anchored to `date`
  // is found by looking at `date`'s weekday, while a session running into `date` from the day
  // before belongs to that day and is returned when that day is queried.
  const open = union([
    ...expandTemplates(templates, date, doctorId),
    ...expandExtraAvailability(exceptions, date, doctorId),
  ]);

  let windows = subtract(open, expandBreaks(templates, breaks, date, doctorId)); // step 4
  windows = subtract(windows, expandBlocks(exceptions, date, doctorId)); // step 5

  /**
   * The time the clinic is open but the doctor is not available: breaks and BLOCKED/HOLIDAY
   * exceptions, and nothing else.
   *
   * It is derived rather than collected, because `open` minus `working` *is* that set by
   * definition — whatever the two subtractions above removed. A separately-built list could
   * disagree with them; this cannot, and a break that stops being subtracted also stops being
   * drawn, which is the correct coupling.
   *
   * It exists because the day view previously had no way to say what an empty stretch meant. A gap
   * between two working windows renders identically whether the doctor is free or on a break, and
   * a receptionist cannot tell "available" from "closed" — the screen was never sent the
   * difference. Clipped to `open` on purpose: time outside working hours entirely is not a break,
   * it is simply not part of the day.
   */
  const unavailableWall = subtract(open, windows);

  // Step 7: wall clock -> instants. The only zone-aware lines in the pipeline.
  const toInstants = (w: Interval): Interval => ({
    start: resolveBoundary(date, w.start, timezone, "start").getTime(),
    end: resolveBoundary(date, w.end, timezone, "end").getTime(),
  });

  const working: Interval[] = windows.map(toInstants);
  const unavailable: Interval[] = unavailableWall.map(toInstants);

  // Step 8: what is taken, in instant space. Wall clock is ambiguous for one hour each autumn —
  // two appointments an hour apart read as the same local time — so subtracting there would
  // remove both occurrences when one is booked.
  const busy = appointments
    .filter((a) => a.doctorId === doctorId && engineOccupies(a))
    .map((a) => {
      const footprint = occupiedFootprint(a);
      return {
        start: new Date(footprint.start),
        end: new Date(footprint.end),
        appointmentId: a.id,
        status: a.status,
      };
    })
    .filter((b) => working.some((w) => b.start.getTime() < w.end && b.end.getTime() > w.start))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const free = subtract(
    working,
    busy.map((b) => ({ start: b.start.getTime(), end: b.end.getTime() })),
  );

  return { working, busy, free, unavailable };
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** `HH:mm` to minutes from local midnight. */
function toMinutes(wall: WallClock): number {
  const [h, m] = wall.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

/**
 * A window's end, in minutes from the anchor date's midnight.
 *
 * `end <= start` means the session crosses midnight and finishes the following day, which
 * PHASE-2.md Q8 rules valid rather than a data error — evening clinics running past midnight are
 * ordinary in Egypt. Adding 1440 rather than rejecting is the whole of that support.
 */
function endMinutes(start: number, end: number): number {
  return end <= start ? end + 1440 : end;
}

/** `null` means every doctor in the tenant (Q13). */
const appliesToDoctor = (rowDoctorId: string | null, doctorId: string): boolean =>
  rowDoctorId === null || rowDoctorId === doctorId;

function templateAppliesOn(t: ScheduleTemplateRow, anchor: string, doctorId: string): boolean {
  if (t.doctorId !== doctorId) return false;
  if (t.weekday !== weekdayOf(anchor)) return false;
  // Q7: both bounds inclusive. "Valid to 30 September" means the 30th is a working day, and
  // half-open is the convention people get wrong. String comparison is safe on ISO dates.
  if (anchor < t.validFrom) return false;
  if (t.validTo !== null && anchor > t.validTo) return false;
  return true;
}

function expandTemplates(
  templates: ScheduleTemplateRow[],
  anchor: string,
  doctorId: string,
): Interval[] {
  return templates
    .filter((t) => templateAppliesOn(t, anchor, doctorId))
    .map((t) => {
      const start = toMinutes(t.startTime);
      return { start, end: endMinutes(start, toMinutes(t.endTime)) };
    });
}

/**
 * Breaks, normalised into their own template's session.
 *
 * A break at 00:30 on a 22:00–02:00 template belongs after midnight, not eighteen hours earlier.
 * Without the shift a night clinic's break would subtract from nothing and quietly stay bookable —
 * which is worse than an error, because the day looks fine.
 */
function expandBreaks(
  templates: ScheduleTemplateRow[],
  breaks: ScheduleBreakRow[],
  anchor: string,
  doctorId: string,
): Interval[] {
  const active = new Map(
    templates.filter((t) => templateAppliesOn(t, anchor, doctorId)).map((t) => [t.id, t]),
  );
  const out: Interval[] = [];
  for (const b of breaks) {
    const template = active.get(b.scheduleTemplateId);
    if (template === undefined) continue;
    const templateStart = toMinutes(template.startTime);
    let start = toMinutes(b.startTime);
    let end = toMinutes(b.endTime);
    if (start < templateStart) {
      start += 1440;
      end += 1440;
    }
    out.push({ start, end: endMinutes(start, end) });
  }
  return out;
}

function expandExtraAvailability(
  exceptions: ScheduleExceptionRow[],
  anchor: string,
  doctorId: string,
): Interval[] {
  return exceptions
    .filter(
      (e) =>
        e.type === "EXTRA_AVAILABILITY" &&
        e.date === anchor &&
        appliesToDoctor(e.doctorId, doctorId) &&
        e.startTime !== null &&
        e.endTime !== null,
    )
    .map((e) => {
      const start = toMinutes(e.startTime as WallClock);
      return { start, end: endMinutes(start, toMinutes(e.endTime as WallClock)) };
    });
}

/**
 * `BLOCKED` and `HOLIDAY`, which **always win** over extra availability (Q12).
 *
 * Stated as a rule and implemented as one — subtracted after everything is unioned, so it cannot
 * lose to a future reordering of the steps. Null times mean the whole session, which is why a
 * whole-day BLOCKED plus an EXTRA_AVAILABILITY window expresses "I work only this evening"
 * without needing a second concept.
 */
function expandBlocks(
  exceptions: ScheduleExceptionRow[],
  anchor: string,
  doctorId: string,
): Interval[] {
  return exceptions
    .filter(
      (e) =>
        (e.type === "BLOCKED" || e.type === "HOLIDAY") &&
        e.date === anchor &&
        appliesToDoctor(e.doctorId, doctorId),
    )
    .map((e) => {
      // A whole-day block must also cover a session running past midnight, hence 2880 not 1440.
      if (e.startTime === null || e.endTime === null) return { start: 0, end: 2880 };
      const start = toMinutes(e.startTime);
      return { start, end: endMinutes(start, toMinutes(e.endTime)) };
    });
}
