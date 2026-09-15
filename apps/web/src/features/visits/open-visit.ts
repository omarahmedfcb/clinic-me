// Who may open the record, and how the app navigates there. Shared by the queue and the panel.
// Mirrors the server's PRESENT set in clinical.access.ts; the server refuses regardless.

export const PRESENT_FOR_VISIT: readonly string[] = ["ARRIVED", "WAITING", "IN_CONSULTATION"];

export function visitPath(appointmentId: string): string {
  return `/visits/${appointmentId}`;
}

/**
 * Whether to offer the way in. Not access control — `visits.write` is DOCTOR-only at the route,
 * and the screen itself refuses when the patient is not present. This only avoids offering a door
 * that would slam shut.
 */
export function mayOpenVisit(
  permissions: Record<string, string>,
  status: string,
): boolean {
  return permissions["visits.write"] !== "none" && PRESENT_FOR_VISIT.includes(status);
}

export function openVisit(appointmentId: string): void {
  window.history.pushState(null, "", visitPath(appointmentId));
  // AppShell listens on popstate; pushState alone does not fire it.
  window.dispatchEvent(new PopStateEvent("popstate"));
}
