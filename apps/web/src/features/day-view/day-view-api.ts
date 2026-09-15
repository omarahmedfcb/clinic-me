/**
 * The day view's single request.
 *
 * `GET /schedule/day` returns `describeDay()` — **the same computation the booking flow cuts
 * availability from**, not a second one. That is the whole constraint on this screen: if the
 * calendar worked availability out by its own route, it and the booking endpoint could disagree,
 * and nothing on screen would say which was right.
 *
 * `schedule-range.integration.spec.ts` already asserts the range endpoint agrees with this one day
 * by day, so all three surfaces — day view, week grid, booking — resolve to one function.
 */

export interface DayWindow {
  start: string;
  end: string;
  utcOffsetMinutes: number;
}

import type { AppointmentStatus } from "../../domain/appointment-status.ts";

export interface DayBusyBlock {
  start: string;
  end: string;
  appointmentId: string;
  /**
   * Only ever one of the six statuses that occupy time. `CANCELLED` and `NO_SHOW` release the
   * slot, so they never reach a timeline -- which is why the strike-through that separates them
   * lives on the badge in a list, and there is nothing to draw for them here.
   */
  status: AppointmentStatus;
}

export interface DayDescription {
  date: string;
  doctorId: string;
  /** Working sessions after breaks and blocks. Empty means the doctor does not work this day. */
  working: DayWindow[];
  busy: DayBusyBlock[];
  free: { start: string; end: string }[];
  /**
   * Breaks and BLOCKED/HOLIDAY time inside the clinic's open hours.
   *
   * Without this the timeline could not say why a stretch was empty: `working` is computed after
   * breaks are subtracted, so a break is indistinguishable from free time on screen. The server
   * derives it as open-minus-working, so it cannot disagree with what was actually removed.
   */
  unavailable: { start: string; end: string }[];
  /**
   * Working time exists but none of it is free.
   *
   * The server computes this rather than the screen inferring it from `free.length === 0`, because
   * "fully booked" and "does not work today" both produce an empty free list and mean opposite
   * things to a receptionist.
   */
  fullyBooked: boolean;
}

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export async function loadDay(
  authFetch: AuthFetch,
  doctorId: string,
  date: string,
): Promise<DayDescription> {
  const response = await authFetch(`/api/schedule/day?doctorId=${doctorId}&date=${date}`);
  if (!response.ok) throw new Error(`GET /schedule/day -> ${response.status}`);
  return (await response.json()) as DayDescription;
}
