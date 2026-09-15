import type { AppointmentStatus } from "../../domain/appointment-status.ts";

/**
 * The detail panel's requests — `PHASE-4.md`.
 *
 * **Three endpoints, deliberately.** The non-clinical detail is one request; the two clinical
 * levels are their own, guarded by `visits.readContent` which only a doctor holds. Reception's
 * client never calls the clinical two, and would be refused at the route if it did — the separation
 * is the server's, not this file's.
 */

export interface AppointmentDetail {
  appointmentId: string;
  status: AppointmentStatus;
  scheduledStart: string;
  scheduledEnd: string;
  source: string;
  complaintSummary: string | null;
  bookingNotes: string | null;
  rescheduleCount: number;
  doctorId: string;
  doctorName: string | null;
  serviceId: string;
  serviceNameAr: string;
  serviceNameEn: string | null;
  serviceDurationMinutes: number;
  patientId: string;
  patientNameAr: string;
  patientNameEn: string | null;
  phoneE164: string;
  secondaryPhone: string | null;
  email: string | null;
  address: string | null;
  /** Null means no payment row exists — which is not the same as nothing owed. */
  payment: {
    status: string;
    amountDueMinor: number;
    amountPaidMinor: number;
    remainingMinor: number | null;
  } | null;
}

export interface ClinicalSummary {
  patientId: string;
  dateOfBirth: string | null;
  gender: string | null;
  allergies: { id: string; substance: string; reaction: string | null; severity: string; recordedAt: string }[];
  /** Null means nobody has ever asked — not the same as "no known allergies". */
  allergiesReviewedAt: string | null;
  /** Derived from the latest prescription, and shown as derived. Empty until prescriptions exist. */
  currentMedication: {
    medicationName: string;
    dose: string;
    frequency: string;
    sourcePrescriptionId: string;
    issuedAt: string;
  }[];
  activeTreatmentPlans: {
    id: string;
    title: string;
    totalSessions: number;
    completedSessions: number;
    startedAt: string;
  }[];
  /** `appointmentId` is what addresses the visit route, which is appointment-scoped. */
  recentVisits: { id: string; appointmentId: string; doctorId: string; at: string }[];
  mayReadFullHistory: boolean;
  appointmentStatus: AppointmentStatus;
}

export interface ClinicalHistory {
  visits: {
    id: string;
    /** The address of the route that opens this visit in full. */
    appointmentId: string;
    doctorId: string;
    completedAt: string | null;
    createdAt: string;
    complaint: string | null;
    medicalHistory: string | null;
    examination: string | null;
    diagnosis: string | null;
    treatmentPlan: string | null;
    doctorNotes: string | null;
    followUpDate: string | null;
  }[];
  prescriptions: {
    id: string;
    issuedAt: string;
    notes: string | null;
    items: { medicationName: string; dose: string; frequency: string; duration: string; instructions: string | null }[];
  }[];
}

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export async function loadDetail(authFetch: AuthFetch, id: string): Promise<AppointmentDetail> {
  const response = await authFetch(`/api/appointments/${id}/detail`);
  if (!response.ok) throw new Error(`GET detail -> ${response.status}`);
  return (await response.json()) as AppointmentDetail;
}

/**
 * Level 1. Returns null when the caller is not a doctor — a 403 here is the expected answer for
 * reception, not an error worth surfacing, because reception's panel never shows this section.
 */
export async function loadSummary(authFetch: AuthFetch, id: string): Promise<ClinicalSummary | null> {
  const response = await authFetch(`/api/appointments/${id}/clinical-summary`);
  if (response.status === 403) return null;
  if (!response.ok) throw new Error(`GET clinical-summary -> ${response.status}`);
  return (await response.json()) as ClinicalSummary;
}

/**
 * Level 2. `NOT_PRESENT` is a first-class outcome rather than a failure: the panel explains that
 * the record opens once the patient is with the doctor, which is information, not an error.
 */
export async function loadHistory(
  authFetch: AuthFetch,
  id: string,
): Promise<{ ok: true; history: ClinicalHistory } | { ok: false; reason: "NOT_PRESENT" | "FORBIDDEN" | "ERROR" }> {
  const response = await authFetch(`/api/appointments/${id}/clinical-history`);
  if (response.ok) return { ok: true, history: (await response.json()) as ClinicalHistory };
  if (response.status === 403) return { ok: false, reason: "FORBIDDEN" };
  if (response.status === 409) return { ok: false, reason: "NOT_PRESENT" };
  return { ok: false, reason: "ERROR" };
}

/**
 * Cancel, with a required reason.
 *
 * The reason is required by the DTO *and* by `transition()` — §9. Two checks rather than one
 * because the AI tool layer will call the service directly and never see the DTO.
 */
export async function cancelAppointment(
  authFetch: AuthFetch,
  id: string,
  reason: string,
): Promise<{ ok: boolean; status: number }> {
  const response = await authFetch(`/api/appointments/${id}/cancel`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  return { ok: response.ok, status: response.status };
}

/**
 * Reschedule — and **change service**, which is the same call.
 *
 * A slot token carries doctor, service, start and end together, so booking a token minted for a
 * different service *is* the service change. There is deliberately no separate "change service"
 * write path: `scheduled_start` is written in exactly two places in the whole API, both from a
 * verified token, so every move goes through the slot engine and the `no_double_booking`
 * exclusion constraint.
 */
export async function rescheduleAppointment(
  authFetch: AuthFetch,
  id: string,
  slotToken: string,
): Promise<{ ok: boolean; status: number }> {
  const response = await authFetch(`/api/appointments/${id}/reschedule`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slotToken }),
  });
  return { ok: response.ok, status: response.status };
}

export async function loadSlots(
  authFetch: AuthFetch,
  doctorId: string,
  serviceId: string,
  date: string,
): Promise<{ token: string; start: string; end: string }[]> {
  const response = await authFetch(
    `/api/availability?doctorId=${doctorId}&serviceId=${serviceId}&date=${date}`,
  );
  if (!response.ok) return [];
  const body = (await response.json()) as { slots: { token: string; start: string; end: string }[] };
  return body.slots;
}
