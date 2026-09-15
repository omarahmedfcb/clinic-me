import type { Interval } from "./interval.ts";

/**
 * The slot engine's contract — PHASE-2.md §7, correcting ARCHITECTURE.md §9.
 *
 * These types are deliberately NOT Prisma models. `domain/` has zero I/O (CLAUDE.md), and
 * importing anything under `src/prisma/` would give a unit spec a hidden dependency on
 * `APP_DATABASE_URL`, which `client.ts` reads at module scope. The service layer maps rows to
 * these shapes; the engine never sees a row.
 *
 * Times come in two flavours and confusing them is the whole hazard of this module:
 *
 * - **Wall clock** (`HH:mm`) — what a schedule template means. "09:00" is nine o'clock wherever
 *   the clinic is, on whatever date it lands, whatever the UTC offset happens to be that day.
 * - **Instant** (`Date`) — an actual point in time. What an appointment occupies, and what the
 *   engine returns.
 *
 * The conversion between them is the only place a timezone is consulted, and it is where both
 * DST hazards live. Everything before it is arithmetic on wall clock that cannot fail.
 */

/** `HH:mm`, 24-hour, tenant-local wall clock. Never an instant. */
export type WallClock = string;

/** `YYYY-MM-DD`, read in the tenant's timezone (PHASE-2.md Q2). Never a `Date`. */
export type CalendarDate = string;

/**
 * A doctor's recurring working window for one weekday.
 *
 * `weekday` follows JS `getDay()`: **Sunday = 0** (PHASE-2.md Q5), resolved in the tenant's
 * timezone, not the server's. Pinned here and in a test because otherwise the seed pins it by
 * accident — Postgres `DOW` agrees, ISO-8601 does not, and the Egyptian week starts Saturday.
 *
 * **`endTime` may be less than `startTime`, and that is not a data error.** It means the session
 * crosses midnight — a 22:00–02:00 evening clinic (PHASE-2.md Q8). Rejecting those was proposed
 * and overruled: they are ordinary in Egypt, and a clinic whose real hours the system refuses to
 * represent is a lost customer. The database enforces only `start_time <> end_time`.
 */
export interface ScheduleTemplateRow {
  id: string;
  doctorId: string;
  weekday: number;
  startTime: WallClock;
  endTime: WallClock;
  validFrom: CalendarDate;
  validTo: CalendarDate | null;
}

/** A break inside one template's window. Subtracted from that template's session only. */
export interface ScheduleBreakRow {
  id: string;
  scheduleTemplateId: string;
  startTime: WallClock;
  endTime: WallClock;
}

/**
 * A one-off change to a date.
 *
 * `doctorId: null` means **every doctor in the tenant** (PHASE-2.md Q13) — what makes `HOLIDAY`
 * meaningfully different from `BLOCKED` rather than a second name for it.
 *
 * `BLOCKED` and `HOLIDAY` **always win** over `EXTRA_AVAILABILITY` (PHASE-2.md Q12). That is a
 * rule, not a consequence of the order the steps happen to run in: step order gets refactored,
 * rules don't.
 */
export interface ScheduleExceptionRow {
  id: string;
  doctorId: string | null;
  date: CalendarDate;
  type: "BLOCKED" | "HOLIDAY" | "EXTRA_AVAILABILITY";
  startTime: WallClock | null;
  endTime: WallClock | null;
}

/**
 * An existing appointment, as far as availability is concerned.
 *
 * `serviceBufferMinutes` is the buffer of **this** appointment's own service, not of the service
 * being booked (PHASE-2.md Q20) — turnaround belongs to the visit that is ending. It widens the
 * occupied footprint to `[start, end + buffer]`; it does not shorten anyone's bookable slot.
 */
export interface OccupancyRow {
  id: string;
  doctorId: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  status: string;
  allowOverlap: boolean;
  serviceBufferMinutes: number;
}

export interface SlotEngineService {
  durationMinutes: number;
  bufferMinutes: number;
}

/**
 * One bookable slot.
 *
 * `utcOffsetMinutes` is not decoration. On the evening Egypt's clocks go back, two slots carry the
 * same wall-clock label an hour apart in real time (PHASE-2.md Q3); the offset is the only thing
 * that distinguishes them, and a UI rendering local time alone would show a duplicate.
 *
 * `sessionDate` is the date the session that produced this slot **began** on, which for a slot
 * after midnight is the day before the slot's own instant falls in (PHASE-2.md Q8b). It is what
 * the day view groups by, and what a `BLOCKED` row matches against.
 */
export interface Slot {
  doctorId: string;
  start: Date;
  end: Date;
  utcOffsetMinutes: number;
  sessionDate: CalendarDate;
}

/**
 * The schedule half of the engine's input. Assembled by the service layer; nothing here is fetched.
 *
 * **`templates` and `exceptions` are for `date` only** — and that is a consequence of Q8b worth
 * spelling out, because the contract said the opposite before Q8b was ruled. Under session
 * anchoring a session belongs to the day it *began* on, so a 22:00–02:00 Thursday clinic is
 * returned in full when Thursday is queried, tail included, and does not appear at all when
 * Friday is queried. There is nothing for the previous day's templates to contribute.
 *
 * **`existingAppointments` is different and still needs a wider net** (Q17): an appointment booked
 * in Wednesday night's tail occupies real time that falls on Thursday's calendar date, so the
 * service fetches by range overlap across the surrounding days rather than by `scheduled_start`
 * falling on `date`.
 */
export interface DayPlanInput {
  /** IANA zone from `tenants.timezone`. Never defaulted, never a literal (CLAUDE.md). */
  timezone: string;
  date: CalendarDate;
  doctorId: string;
  templates: ScheduleTemplateRow[];
  breaks: ScheduleBreakRow[];
  exceptions: ScheduleExceptionRow[];
  existingAppointments: OccupancyRow[];
}

/**
 * One appointment's footprint on the day view, buffer included.
 *
 * Carries `appointmentId` because the reception day view has to be clickable — a busy block the
 * user cannot open is a wall, not a calendar.
 */
export interface BusyBlock {
  start: Date;
  end: Date;
  appointmentId: string;
  /**
   * The appointment's status, so a calendar can colour the block.
   *
   * Only ever one of the six statuses that occupy time. `CANCELLED` and `NO_SHOW` release the slot
   * (see `occupancy.ts`), so they are filtered out before a block is built and can never reach a
   * day view -- which is why the red pair's distinction is carried by the badge in a list, not by
   * anything on the timeline.
   */
  status: string;
}

/**
 * The shared intermediate that `generateSlots()` and `describeDay()` are both derived from.
 *
 * PHASE-2.md Q25: two functions, one computation. A day view that recomputed availability by its
 * own route is how the calendar and the booking flow end up disagreeing — the calendar showing a
 * gap the booking endpoint refuses, with no way to tell which one is wrong.
 */
export interface DayPlan {
  /** Working sessions, after breaks and blocks, before occupancy. What the day view draws. */
  working: Interval[];
  /** Time taken by appointments, including each one's own service buffer. */
  busy: BusyBlock[];
  /** `working` minus `busy`. What slots are cut from. */
  free: Interval[];
  /**
   * Open hours the doctor is *not* available for: breaks and BLOCKED/HOLIDAY exceptions.
   *
   * Never cut into slots — it is the opposite of `working`. It exists so a calendar can say why a
   * stretch is empty, which `working`/`free` alone cannot: a gap between two working windows looks
   * the same whether the doctor is free or at lunch.
   */
  unavailable: Interval[];
}

export interface GenerateSlotsInput extends DayPlanInput {
  service: SlotEngineService;
  /** Server-resolved from `tenants.slot_granularity_minutes`. Never caller-supplied (Q18). */
  granularityMinutes: number;
  /** Per source (Q22). Staff 0; a remote self-service channel higher. Subsumes "in the past". */
  leadMinutes: number;
  /** Passed in, never read from the clock. A `new Date()` in this module is a bug. */
  now: Date;
}
