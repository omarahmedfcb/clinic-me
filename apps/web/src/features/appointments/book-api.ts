// «المواعيد» — the appointment book. Phase 5 PR 13.
// The month is counts only; opening a day is what fetches its bookings.

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface MonthDay {
  date: string;
  /** Still standing: the primary number. */
  total: number;
  /** Completed, cancelled and no-show together — muted, so a past month is readable. */
  finished: number;
  byDoctor: { doctorId: string; doctorName: string; count: number }[];
}

export interface MonthBook {
  month: string;
  days: MonthDay[];
  doctors: { id: string; name: string }[];
  /** True for a doctor: their own days, and neither booking nor moving is offered. */
  readOnly: boolean;
}

export interface DayBooking {
  appointmentId: string;
  patientName: string;
  doctorId: string;
  doctorName: string;
  serviceId: string;
  serviceName: string;
  startsAt: string;
  status: string;
}

export interface Slot {
  slotToken: string;
  startsAt: string;
  endsAt: string;
}

type Refused = { ok: false; code: string; params: Record<string, unknown> };

async function refusal(response: Response): Promise<Refused> {
  const body: unknown = await response.json().catch(() => null);
  const shape = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  return {
    ok: false,
    code: typeof shape["code"] === "string" ? (shape["code"] as string) : "INTERNAL",
    params: (shape["params"] as Record<string, unknown>) ?? {},
  };
}

/**
 * Both readers throw on a refusal rather than answering with emptiness.
 *
 * They used to return an empty month and an empty booking list, which is how a 400 from the query
 * DTO reached the founder as "لا توجد مواعيد" on every day of a seeded month: the screen asserted
 * there was nothing booked when what it actually knew was that the server had refused to say.
 */
export async function loadMonth(
  authFetch: AuthFetch,
  month: string,
  doctorId?: string,
): Promise<MonthBook> {
  const query = doctorId === undefined ? `month=${month}` : `month=${month}&doctorId=${doctorId}`;
  const response = await authFetch(`/api/schedule/month?${query}`);
  if (!response.ok) throw new Error(`GET /schedule/month -> ${response.status}`);
  return (await response.json()) as MonthBook;
}

/**
 * A day's bookings — every doctor, or one when `doctorId` is given.
 *
 * Not the day view's `schedule/day`: that is a timeline of working hours, busy blocks and gaps, and
 * it carries no patient name because it does not need one. This is a list a receptionist reads.
 */
export async function loadDay(
  authFetch: AuthFetch,
  date: string,
  doctorId = "",
): Promise<DayBooking[]> {
  const query = doctorId === "" ? `date=${date}` : `date=${date}&doctorId=${doctorId}`;
  const response = await authFetch(`/api/schedule/day/bookings?${query}`);
  if (!response.ok) throw new Error(`GET /schedule/day/bookings -> ${response.status}`);
  const body = (await response.json()) as { bookings?: DayBooking[] };
  return body.bookings ?? [];
}

export async function loadSlots(
  authFetch: AuthFetch,
  input: { doctorId: string; serviceId: string; date: string },
): Promise<Slot[]> {
  const response = await authFetch(
    `/api/availability?doctorId=${input.doctorId}&serviceId=${input.serviceId}&date=${input.date}`,
  );
  if (!response.ok) return [];
  const body = (await response.json()) as { slots?: Slot[] };
  return body.slots ?? [];
}

/**
 * Books into a slot the server offered.
 *
 * **The doctor and the time are inside the signed token**, never sent alongside it: a client cannot
 * name an arbitrary instant, which is what keeps the slot engine and the exclusion constraint the
 * only things that decide whether a booking is possible.
 */
export async function book(
  authFetch: AuthFetch,
  input: { slotToken: string; patientId: string },
): Promise<{ ok: true } | Refused> {
  const response = await authFetch("/api/appointments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, source: "RECEPTION" }),
  });
  return response.ok ? { ok: true } : refusal(response);
}

/** A move. Same token, same constraint, same state machine as a booking — never a raw update. */
export async function moveAppointment(
  authFetch: AuthFetch,
  appointmentId: string,
  slotToken: string,
): Promise<{ ok: true } | Refused> {
  const response = await authFetch(`/api/appointments/${appointmentId}/reschedule`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slotToken }),
  });
  return response.ok ? { ok: true } : refusal(response);
}
