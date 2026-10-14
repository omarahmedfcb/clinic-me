// When a reminder goes out and how long the patient has to answer it. Pure: no database, no clock of
// its own -- `now` is an argument, the same discipline the slot engine and `domain/no-show.ts` keep.
//
// ## The rule, and the three ways it bends
//
// The rule is "remind `leadHours` before the appointment, and cancel it if the patient has not
// answered `confirmWindowHours` later". Applied literally it has three failures, all of which land at
// night or in a hurry:
//
//  1. **Quiet hours.** A 08:00 appointment would be reminded at 03:00 and cancelled at 05:00 while the
//     patient sleeps. A reminder is never sent between 21:00 and 08:00 clinic time; it waits for 08:00.
//  2. **No room for the window.** Pushed to 08:00, a 09:00 appointment has an hour left, not two. The
//     cancel deadline is capped 30 minutes before the start, and when that leaves less than an hour to
//     answer, the reminder is still sent but nothing is cancelled: cancelling someone who had
//     fifteen minutes to see a message is the clinic's gap, not the patient's no-show.
//  3. **Booked at short notice.** A visit booked three hours ahead has no 5h + 2h cycle to run, and a
//     patient who just booked has not forgotten. It gets no auto-cancel.
//
// And one that is not a bend: an appointment reception already confirmed is reminded but never
// cancelled for silence. A person at the desk has already spoken to this patient.

import { calendarDayIn, instantsForLocal, offsetMinutesAt } from "../appointments/domain/zoned-time.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** The first minute of the day a reminder may be sent, clinic time. */
export const QUIET_HOURS_END_MINUTES = 8 * 60;
/** The first minute of the night a reminder may NOT be sent, clinic time. */
export const QUIET_HOURS_START_MINUTES = 21 * 60;

/** Cancelling is refused if the patient would have had less than this to answer. */
export const MIN_CONFIRM_WINDOW_MS = HOUR_MS;
/** The cancel deadline stops this long before the appointment, so the slot is freed while it is still useful. */
export const DEADLINE_MARGIN_MS = 30 * MINUTE_MS;
/** A reminder sent closer to the start than this is no use to anyone. */
export const MIN_USEFUL_LEAD_MS = HOUR_MS;

export interface ReminderPolicy {
  leadHours: number;
  confirmWindowHours: number;
}

export interface ReminderInput {
  scheduledStart: Date;
  /** When the appointment was booked: decides whether a full cycle was ever possible. */
  bookedAt: Date;
  status: "BOOKED" | "CONFIRMED";
  timeZone: string;
  policy: ReminderPolicy;
  now: Date;
}

export interface ReminderPlan {
  sendAt: Date;
  /** Null: this reminder never cancels the appointment. */
  respondBy: Date | null;
}

function localMinutesOfDay(instant: Date, timeZone: string): number {
  const local = instant.getTime() / MINUTE_MS + offsetMinutesAt(instant, timeZone);
  return ((Math.floor(local) % 1440) + 1440) % 1440;
}

/**
 * The next instant at or after `instant` that is not inside quiet hours.
 *
 * Quiet hours span midnight, so there are two cases: after 21:00 the next 08:00 is tomorrow's, and
 * before 08:00 it is today's. `instantsForLocal` is the DST-aware part -- on the night the clocks move,
 * "08:00" may not be five hours after "03:00", and a fixed offset would be wrong by one.
 */
export function outsideQuietHours(instant: Date, timeZone: string): Date {
  const minutes = localMinutesOfDay(instant, timeZone);
  if (minutes >= QUIET_HOURS_END_MINUTES && minutes < QUIET_HOURS_START_MINUTES) return instant;

  const today = calendarDayIn(instant, timeZone);
  const dayShift = minutes >= QUIET_HOURS_START_MINUTES ? 1 : 0;
  const morning = instantsForLocal(today, QUIET_HOURS_END_MINUTES + dayShift * 1440, timeZone)[0];
  // 08:00 is never inside a spring-forward gap in a zone that changes at night; if one ever were, the
  // conservative answer is to keep the original instant rather than invent one.
  return morning ?? instant;
}

/**
 * Null: no reminder is worth sending for this appointment.
 *
 * Called repeatedly by the sweeper with a moving `now`, and must give the same answer for the same
 * appointment each time until `sendAt` passes -- so `now` only ever lifts `sendAt` off a moment already
 * gone (a clinic that switched reminders on this afternoon), never reshapes a plan.
 */
export function planReminder(input: ReminderInput): ReminderPlan | null {
  const { scheduledStart, bookedAt, status, timeZone, policy, now } = input;
  const leadMs = policy.leadHours * HOUR_MS;
  const windowMs = policy.confirmWindowHours * HOUR_MS;

  const target = Math.max(scheduledStart.getTime() - leadMs, bookedAt.getTime() + 30 * MINUTE_MS, now.getTime());
  const sendAt = outsideQuietHours(new Date(target), timeZone);

  if (scheduledStart.getTime() - sendAt.getTime() < MIN_USEFUL_LEAD_MS) return null;

  // Reception already spoke to this patient, or the booking was too recent for a full cycle.
  const fullCyclePossible = scheduledStart.getTime() - bookedAt.getTime() >= leadMs + windowMs;
  if (status !== "BOOKED" || !fullCyclePossible) return { sendAt, respondBy: null };

  const deadline = Math.min(sendAt.getTime() + windowMs, scheduledStart.getTime() - DEADLINE_MARGIN_MS);
  if (deadline - sendAt.getTime() < MIN_CONFIRM_WINDOW_MS) return { sendAt, respondBy: null };

  return { sendAt, respondBy: new Date(deadline) };
}

/** One reminder per appointment *time*: a reschedule is a different appointment slot and gets its own. */
export function reminderDedupeKey(appointmentId: string, scheduledStart: Date): string {
  return `reminder:${appointmentId}:${Math.floor(scheduledStart.getTime() / MINUTE_MS)}`;
}
