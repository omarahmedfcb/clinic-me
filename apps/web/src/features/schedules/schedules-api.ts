/**
 * The schedule editor's view of the API. Types only, plus thin fetch wrappers.
 *
 * Mirrors `apps/api/src/modules/schedules/` — CLAUDE.md's rule that modules mirror between the two
 * trees. These shapes are hand-written rather than shared through `packages/shared-types`, which
 * is the same choice the auth feature made; when a third feature needs them, that is the moment to
 * move them, not before.
 *
 * ## Two things the API's contract forces on this screen
 *
 * **`weekday` is JS `getDay()`, Sunday = 0** (PHASE-2.md Q5). The Egyptian week starts Saturday, so
 * this file exports a *display* order that begins at 6 while leaving the values untouched.
 * Renumbering them here would put every clinic's Monday on the wrong day.
 *
 * **`endTime` may be earlier than `startTime`.** That is a session crossing midnight (Q8), not a
 * validation error — evening clinics running past midnight are ordinary in Egypt, and the API
 * accepts them deliberately. The editor must let one be entered. Only `start === end` is refused.
 */

export interface DoctorSummary {
  id: string;
  membershipId: string;
  fullName: string;
  title: string;
  specialty: string;
  licenseNumber: string;
  isActive: boolean;
}

export interface ScheduleBreak {
  id?: string;
  startTime: string;
  endTime: string;
  label: string;
}

export interface ScheduleTemplate {
  id?: string;
  weekday: number;
  startTime: string;
  endTime: string;
  validFrom: string;
  validTo: string | null;
  breaks: ScheduleBreak[];
}

export type ExceptionType = "BLOCKED" | "HOLIDAY" | "EXTRA_AVAILABILITY";

export interface ScheduleException {
  id: string;
  /** `null` means every doctor in the clinic (PHASE-2.md Q13). */
  doctorId: string | null;
  date: string;
  type: ExceptionType;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
}

export interface DoctorSchedule {
  doctorId: string;
  templates: ScheduleTemplate[];
  exceptions: ScheduleException[];
}

/**
 * Display order: Saturday first, because that is where the Egyptian week starts. The *values* are
 * unchanged — 6 is Saturday under `getDay()` — and must stay that way.
 */
export const WEEKDAY_DISPLAY_ORDER = [6, 0, 1, 2, 3, 4, 5] as const;

export const EXCEPTION_TYPES: readonly ExceptionType[] = ["BLOCKED", "HOLIDAY", "EXTRA_AVAILABILITY"];

/** One day of the weekly grid — `describeDay()`'s shape, plus its date. */
export interface WeekDay {
  date: string;
  working: { start: string; end: string; utcOffsetMinutes: number }[];
  busy: { start: string; end: string; appointmentId: string }[];
  free: { start: string; end: string }[];
  fullyBooked: boolean;
}

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * The whole week in one request.
 *
 * Not seven `/schedule/day` calls: measured at 639 ms against 130 ms, and — more importantly —
 * seven requests are seven snapshots that can disagree with each other if anyone books in between.
 * The endpoint runs the same `describeDay()` per date over a single fetch, asserted equal to the
 * single-day answer by `schedule-range.integration.spec.ts`.
 */
export async function loadWeek(
  authFetch: AuthFetch,
  doctorId: string,
  from: string,
  to: string,
): Promise<WeekDay[]> {
  const response = await authFetch(
    `/api/schedule/range?doctorId=${doctorId}&from=${from}&to=${to}`,
  );
  if (!response.ok) throw new Error(`GET /schedule/range -> ${response.status}`);
  return ((await response.json()) as { days: WeekDay[] }).days;
}

export async function loadDoctors(authFetch: AuthFetch): Promise<DoctorSummary[]> {
  const response = await authFetch("/api/doctors");
  if (!response.ok) throw new Error(`GET /doctors -> ${response.status}`);
  return (await response.json()) as DoctorSummary[];
}

export async function loadSchedule(authFetch: AuthFetch, doctorId: string): Promise<DoctorSchedule> {
  const response = await authFetch(`/api/doctors/${doctorId}/schedule`);
  if (!response.ok) throw new Error(`GET /doctors/:id/schedule -> ${response.status}`);
  return (await response.json()) as DoctorSchedule;
}

/**
 * The whole set at once, because overlap is a property of the set rather than of a row (Q6). The
 * editor holds a working copy and PUTs all of it.
 *
 * A rejection is returned rather than thrown: the API answers 400 with a message naming the two
 * templates that overlap, and that message is more use to a receptionist than "save failed".
 */
export async function saveTemplates(
  authFetch: AuthFetch,
  doctorId: string,
  templates: ScheduleTemplate[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  const response = await authFetch(`/api/doctors/${doctorId}/schedule/templates`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      templates: templates.map((t) => ({
        weekday: t.weekday,
        startTime: t.startTime,
        endTime: t.endTime,
        validFrom: t.validFrom,
        validTo: t.validTo,
        breaks: t.breaks.map((b) => ({ startTime: b.startTime, endTime: b.endTime, label: b.label })),
      })),
    }),
  });

  if (response.ok) return { ok: true };
  return { ok: false, message: await messageFrom(response) };
}

export async function addException(
  authFetch: AuthFetch,
  doctorId: string,
  input: {
    clinicWide: boolean;
    date: string;
    type: ExceptionType;
    startTime: string | null;
    endTime: string | null;
    reason: string | null;
  },
): Promise<{ ok: true } | { ok: false; message: string }> {
  const response = await authFetch(`/api/doctors/${doctorId}/schedule/exceptions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // `doctorId: null` in the body is what asks for a clinic-wide row; the path still names the
    // doctor, and the API takes the path's value for a per-doctor exception. A DOCTOR-role user
    // gets 404 for the clinic-wide case, so the control is hidden for them rather than offered
    // and refused.
    body: JSON.stringify({
      doctorId: input.clinicWide ? null : doctorId,
      date: input.date,
      type: input.type,
      startTime: input.startTime,
      endTime: input.endTime,
      reason: input.reason,
    }),
  });

  if (response.ok) return { ok: true };
  return { ok: false, message: await messageFrom(response) };
}

export async function removeException(
  authFetch: AuthFetch,
  doctorId: string,
  exceptionId: string,
): Promise<boolean> {
  const response = await authFetch(`/api/doctors/${doctorId}/schedule/exceptions/${exceptionId}`, {
    method: "DELETE",
  });
  return response.ok;
}

/** Nest's error body is `{ message }`, sometimes an array of them from the validation pipe. */
async function messageFrom(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) return body.message.join(" · ");
    if (typeof body.message === "string") return body.message;
  } catch {
    // Not JSON. Fall through to the status, which is still more than nothing.
  }
  return `HTTP ${response.status}`;
}
