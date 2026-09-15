/**
 * Booking: the client for the flow reception uses all day and which had no screen until now.
 *
 * The slot engine, `/availability` and `POST /appointments` all existed and nothing in `apps/web`
 * called them — the core booking flow was reachable only by hand-written HTTP.
 *
 * **The token is the whole design.** `/availability` mints a signed slot token carrying doctor,
 * service, start and end together; `POST /appointments` takes that token, a patient and a source,
 * and nothing else. There is deliberately no `start` or `doctorId` in the booking request
 * (`PHASE-2.md` Q24), so a client cannot disagree with the offer it was given. This file must
 * therefore never construct a time — it can only pass back a token the server minted.
 */

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface ServiceOption {
  id: string;
  nameAr: string;
  nameEn: string | null;
  durationMinutes: number;
  priceMinor: number;
}

export interface PatientMatch {
  id: string;
  fullNameAr: string;
  fullNameEn: string | null;
  phoneE164: string;
}

export interface Slot {
  token: string;
  start: string;
  end: string;
}

export interface BookingRefusal {
  reason: string;
  message: string;
}

export type BookingOutcome = { ok: true; appointmentId: string } | { ok: false; refusal: BookingRefusal };

async function refusalOf(response: Response): Promise<BookingRefusal> {
  try {
    const body = (await response.json()) as { reason?: string; message?: string };
    return { reason: body.reason ?? "UNKNOWN", message: body.message ?? "تعذّر حجز الموعد." };
  } catch {
    return { reason: "UNKNOWN", message: "تعذّر حجز الموعد." };
  }
}

export async function loadServices(authFetch: AuthFetch): Promise<ServiceOption[]> {
  const response = await authFetch("/api/services");
  if (!response.ok) throw new Error(`services: ${response.status}`);
  return (await response.json()) as ServiceOption[];
}

/**
 * Patient search. **Returns every match, and the caller must not assume one.**
 *
 * `PHASE-3.md` Q5: a phone can be shared by two patients — a mother booking for a child gives her
 * own number — so a screen that silently took the first result would book the wrong person, and the
 * mistake would only surface in the consulting room.
 */
export async function searchPatients(authFetch: AuthFetch, query: string): Promise<PatientMatch[]> {
  if (query.trim().length === 0) return [];
  const response = await authFetch(`/api/patients?q=${encodeURIComponent(query.trim())}&limit=10`);
  if (!response.ok) return [];
  return (await response.json()) as PatientMatch[];
}

export async function loadSlots(
  authFetch: AuthFetch,
  doctorId: string,
  serviceId: string,
  date: string,
): Promise<Slot[]> {
  const response = await authFetch(
    `/api/availability?doctorId=${doctorId}&serviceId=${serviceId}&date=${date}`,
  );
  if (!response.ok) return [];
  return ((await response.json()) as { slots: Slot[] }).slots;
}

export async function bookAppointment(
  authFetch: AuthFetch,
  input: { slotToken: string; patientId: string; complaintSummary?: string },
): Promise<BookingOutcome> {
  const response = await authFetch("/api/appointments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slotToken: input.slotToken,
      patientId: input.patientId,
      // Reception is booking at the desk. The server derives the booking channel from this, and a
      // staff lead time of zero is right for someone standing in front of you (Q22).
      source: "RECEPTION",
      ...(input.complaintSummary === undefined || input.complaintSummary.trim().length === 0
        ? {}
        : { complaintSummary: input.complaintSummary.trim() }),
    }),
  });
  if (!response.ok) return { ok: false, refusal: await refusalOf(response) };
  const body = (await response.json()) as { appointmentId: string };
  return { ok: true, appointmentId: body.appointmentId };
}

/**
 * Reschedule — the same slot token, against an existing appointment.
 *
 * Rescheduling and changing the service are the *same call*, because the token carries both. That
 * is why this takes no service argument: picking a slot minted for a different service is the
 * service change.
 */
export async function rescheduleAppointment(
  authFetch: AuthFetch,
  appointmentId: string,
  slotToken: string,
): Promise<BookingOutcome> {
  const response = await authFetch(`/api/appointments/${appointmentId}/reschedule`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slotToken }),
  });
  if (!response.ok) return { ok: false, refusal: await refusalOf(response) };
  return { ok: true, appointmentId };
}

/**
 * One patient by id — Q32. Search cannot answer this: it matches name, phone and national ID, and a
 * UUID is none of those, so searching by id returns nothing and selects nobody.
 */
export async function loadPatientById(
  authFetch: AuthFetch,
  patientId: string,
): Promise<PatientMatch | null> {
  const response = await authFetch(`/api/patients/${patientId}`);
  if (!response.ok) return null;
  const patient = (await response.json()) as PatientMatch;
  return { id: patient.id, fullNameAr: patient.fullNameAr, fullNameEn: patient.fullNameEn, phoneE164: patient.phoneE164 };
}
