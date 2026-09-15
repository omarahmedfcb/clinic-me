/**
 * `GET /appointments/:id/visit` and the gated attachment download — `PHASE-4.md` Q18 (revised
 * 2026-09-05), Q11.
 *
 * **Appointment-scoped, not visit-scoped.** A `GET /visits/:id` version existed and was reversed:
 * every clinical read in this project resolves ownership through the appointment, and a second
 * ownership path is a check that has to stay in step with its sibling. The consequence for this
 * file is that opening a past visit needs its *appointment* id — which is why `ClinicalHistory` and
 * `ClinicalSummary` now carry one per entry.
 */

export interface VisitAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  category: string;
  description: string | null;
  createdAt: string;
  archivedAt: string | null;
}

export interface VisitRevision {
  id: string;
  changedFields: unknown;
  previousValues: unknown;
  actorUserId: string;
  reason: string;
  createdAt: string;
}

export interface VisitDetail {
  id: string;
  patientId: string;
  doctorId: string;
  appointmentId: string;
  status: string;
  completedAt: string | null;
  createdAt: string;
  complaint: string | null;
  medicalHistory: string | null;
  examination: string | null;
  diagnosis: string | null;
  treatmentPlan: string | null;
  doctorNotes: string | null;
  followUpDate: string | null;
  followUpIntervalDays: number | null;
  attachments: VisitAttachment[];
  /**
   * Amendments to this visit, newest first.
   *
   * Empty until the amendment flow exists — nothing writes `visit_revisions` yet. The screen shows
   * the section only when there is something in it, because "no corrections" and "corrections are
   * not built" are different statements and an empty heading would assert the first.
   */
  revisions: VisitRevision[];
}

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * One visit.
 *
 * `NOT_PERMITTED` is a first-class outcome rather than a failure, for the same reason
 * `loadHistory`'s `NOT_PRESENT` is: a doctor clicking a colleague's visit needs to be told the
 * record is not theirs to open, which is information. Treating it as an error would show a broken
 * screen for a working rule.
 */
export async function loadVisit(
  authFetch: AuthFetch,
  appointmentId: string,
): Promise<
  | { ok: true; visit: VisitDetail }
  | { ok: false; reason: "NOT_PRESENT" | "NOT_FOUND" | "ERROR" }
> {
  const response = await authFetch(`/api/appointments/${appointmentId}/visit`);
  if (response.ok) return { ok: true, visit: (await response.json()) as VisitDetail };
  // 409, matching `loadHistory`: the record opens while the patient is in this doctor's care. It is
  // information, not a failure, and the screen says so rather than showing an error.
  if (response.status === 409) return { ok: false, reason: "NOT_PRESENT" };
  if (response.status === 404) return { ok: false, reason: "NOT_FOUND" };
  return { ok: false, reason: "ERROR" };
}

/**
 * Fetches an attachment's bytes and hands them to the browser as a download.
 *
 * **It has to go through `authFetch`, which is why this is not an `<a href>`.** The content route is
 * behind `visits.readContent` and takes a bearer token; a plain link sends no `Authorization`
 * header and would get a 401 that looks like a broken file. That is the client-side consequence of
 * Q11's rule that attachments are never served from a public URL — the absence of one is the point,
 * so the download is assembled here instead.
 *
 * The object URL is revoked immediately after the click. Left alive it pins the whole file in
 * memory for the life of the tab, which for a 10 MB scan on a clinic laptop is worth two lines.
 */
export async function downloadAttachment(
  authFetch: AuthFetch,
  attachmentId: string,
  fileName: string,
): Promise<{ ok: boolean; status: number }> {
  const response = await authFetch(`/api/attachments/${attachmentId}/content`);
  if (!response.ok) return { ok: false, status: response.status };

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  // The server also sets `Content-Disposition: attachment`; this names the saved file, which a
  // blob URL otherwise would not.
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  return { ok: true, status: response.status };
}
