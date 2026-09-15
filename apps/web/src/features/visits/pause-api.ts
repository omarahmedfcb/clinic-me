// Pausing and resuming a consultation — Q34. The doctor's own act about their own consultation.
// `visits.write` is DOCTOR-only at the route, and the service refuses a colleague's appointment.

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export async function pauseVisit(
  authFetch: AuthFetch,
  appointmentId: string,
  reason: string,
): Promise<boolean> {
  const response = await authFetch(`/api/queue/${appointmentId}/pause`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedStatus: "IN_CONSULTATION",
      ...(reason === "" ? {} : { reason }),
    }),
  });
  return response.ok;
}

export async function resumeVisit(
  authFetch: AuthFetch,
  appointmentId: string,
): Promise<boolean> {
  const response = await authFetch(`/api/queue/${appointmentId}/resume`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedStatus: "PAUSED" }),
  });
  return response.ok;
}
