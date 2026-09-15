// Sick leave on the visit — Q46. Same shape as the prescription's client: read, save, count a print.

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface SickLeave {
  days: number | null;
  /** ISO calendar day, or null. Never a timestamp: leave starts on a day. */
  from: string | null;
  note: string | null;
  printedCount: number;
}

export const NO_SICK_LEAVE: SickLeave = { days: null, from: null, note: null, printedCount: 0 };

// The paths are written out at every call site rather than built by a helper. The route↔capability
// manifest reads these literals to check the client only calls routes the API serves; a helper
// hides them from it, and it said so rather than passing.

export async function loadSickLeave(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
): Promise<SickLeave> {
  const response = await authFetch(
    `/api/appointments/${appointmentId}/visit/${visitId}/sick-leave`,
  );
  if (!response.ok) return NO_SICK_LEAVE;
  const body: unknown = await response.json();
  // A payload that is not an object reads as no certificate, rather than putting `undefined` on a
  // printed page — the lesson `CoverageBadge` records from a built client meeting an older API.
  return typeof body === "object" && body !== null ? { ...NO_SICK_LEAVE, ...body } : NO_SICK_LEAVE;
}

export async function saveSickLeave(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
  input: { days: number | null; from: string | null; note: string | null },
): Promise<SickLeave | null> {
  const response = await authFetch(`/api/appointments/${appointmentId}/visit/${visitId}/sick-leave`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return response.ok ? ((await response.json()) as SickLeave) : null;
}

/** Recorded before the dialog opens, like the prescription's: the outcome is not observable. */
export async function recordSickLeavePrinted(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
): Promise<void> {
  await authFetch(`/api/appointments/${appointmentId}/visit/${visitId}/sick-leave/printed`, {
    method: "POST",
  });
}
