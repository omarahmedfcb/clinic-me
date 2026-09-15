// The visit draft endpoints, and everything the visit screen reads or writes. Q2, Q4, Q7, Q17.
// A stale save is an outcome the screen must show, never an error it can retry through.

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface VisitDraft {
  id: string;
  appointmentId: string;
  /** Whose visit this is. The print sheets need it to name the doctor who signs them (Q28). */
  doctorId: string;
  revision: number;
  complaint: string | null;
  medicalHistory: string | null;
  examination: string | null;
  diagnosis: string | null;
  treatmentPlan: string | null;
  doctorNotes: string | null;
  updatedAt: string;
  resumed: boolean;
  /** PR 7b. Sent on open only — the screen needs the age for the paediatric field, and the last
   *  completed visit's numbers so this visit's read as a trend. */
  vitals?: Record<string, number> | null;
  patientDateOfBirth?: string | null;
  previousVitals?: Record<string, number> | null;
}

export type DraftField =
  | "complaint"
  | "medicalHistory"
  | "examination"
  | "diagnosis"
  | "treatmentPlan"
  | "doctorNotes";

/** `medicalHistory` is the history of *present illness* since Q23; past history is the profile. */
export const DRAFT_FIELDS: readonly DraftField[] = [
  "complaint",
  "medicalHistory",
  "examination",
  "diagnosis",
  "treatmentPlan",
  "doctorNotes",
];

export type OpenResult =
  | { ok: true; draft: VisitDraft }
  | { ok: false; reason: "NOT_PRESENT" | "NOT_A_DOCTOR" | "NOT_FOUND" | "ERROR" };

export async function openDraft(authFetch: AuthFetch, appointmentId: string): Promise<OpenResult> {
  const response = await authFetch(`/api/appointments/${appointmentId}/visit/draft`, { method: "POST" });
  if (response.ok) return { ok: true, draft: (await response.json()) as VisitDraft };
  if (response.status === 409) return { ok: false, reason: "NOT_PRESENT" };
  if (response.status === 403) return { ok: false, reason: "NOT_A_DOCTOR" };
  if (response.status === 404) return { ok: false, reason: "NOT_FOUND" };
  return { ok: false, reason: "ERROR" };
}

export type SaveResult =
  | { ok: true; draft: VisitDraft }
  /** Someone saved first. `currentRevision` is what the row now holds. */
  | { ok: false; reason: "STALE"; currentRevision: number }
  | { ok: false; reason: "ERROR" };

export async function saveDraft(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
  expectedRevision: number,
  patch: Partial<Record<DraftField, string>> & { vitals?: Record<string, number> },
): Promise<SaveResult> {
  const response = await authFetch(
    `/api/appointments/${appointmentId}/visit/draft/${visitId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision, ...patch }),
    },
  );
  if (response.ok) return { ok: true, draft: (await response.json()) as VisitDraft };
  if (response.status === 409) {
    const body = (await response.json()) as { params?: { revision?: number } };
    return { ok: false, reason: "STALE", currentRevision: body.params?.revision ?? expectedRevision };
  }
  return { ok: false, reason: "ERROR" };
}

// --- PR 7e: the profile, the patient header, what the visit orders, and what it did -------------

export type ProfileField =
  | "PAST_MEDICAL"
  | "PAST_SURGICAL"
  | "CHRONIC_CONDITIONS"
  | "CHRONIC_MEDICATIONS"
  | "FAMILY_HISTORY"
  | "RISK_FACTORS";

export const PROFILE_FIELDS: readonly ProfileField[] = [
  "PAST_MEDICAL",
  "PAST_SURGICAL",
  "CHRONIC_CONDITIONS",
  "CHRONIC_MEDICATIONS",
  "FAMILY_HISTORY",
  "RISK_FACTORS",
];

export interface ProfileEntry {
  id: string;
  field: ProfileField;
  content: string;
  authorUserId: string;
  authorName: string;
  createdAt: string;
}

export interface ClinicalProfileView {
  patientId: string;
  entries: ProfileEntry[];
  lastUpdatedAt: string | null;
  lastUpdatedBy: string | null;
  heightCm: number | null;
  firstVisit: boolean;
}

export async function loadClinicalProfile(
  authFetch: AuthFetch,
  appointmentId: string,
): Promise<ClinicalProfileView | null> {
  const response = await authFetch(`/api/appointments/${appointmentId}/clinical-profile`);
  return response.ok ? ((await response.json()) as ClinicalProfileView) : null;
}

/** Append one entry. There is no update and no delete, here or at the database — Q22. */
export async function addProfileEntry(
  authFetch: AuthFetch,
  appointmentId: string,
  entry: { field: ProfileField; content: string },
): Promise<ClinicalProfileView | null> {
  const response = await authFetch(`/api/appointments/${appointmentId}/clinical-profile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(entry),
  });
  return response.ok ? ((await response.json()) as ClinicalProfileView) : null;
}

export interface PatientHeader {
  patientId: string;
  /** Per clinic and sequential (Phase 5 PR 2) — what the printed patient block carries. */
  fileNumber: number;
  fullNameAr: string;
  fullNameEn: string | null;
  /** Q45: the transliteration search maintains (D19), used when there is no English name. */
  nameSearchLatin: string | null;
  dateOfBirth: string | null;
  gender: string | null;
  phoneE164: string;
  /** D26, derived server-side. The doctor may fill the three of these they can actually answer. */
  missingIntakeFields: string[];
  allergies: { id: string; substance: string; severity: string }[];
  allergiesReviewedAt: string | null;
  coverage: { standing: "COVERED" | "LAPSED" | "NONE"; insurerName?: string };
  visitCount: number;
  lastVisitAt: string | null;
}

/** The safety summary, which already carries everything Q21's header needs. One endpoint, not two. */
export async function loadPatientHeader(
  authFetch: AuthFetch,
  appointmentId: string,
): Promise<PatientHeader | null> {
  const response = await authFetch(`/api/appointments/${appointmentId}/clinical-summary`);
  return response.ok ? ((await response.json()) as PatientHeader) : null;
}

export interface PrescriptionLine {
  medicationName: string;
  /** Q45. Null on every line written before the split, which prints as an empty cell. */
  strength: string | null;
  form: string | null;
  quantity: string | null;
  dose: string;
  frequency: string;
  duration: string;
  instructions: string | null;
}

export interface VisitPrescription {
  prescriptionId: string | null;
  notes: string | null;
  items: PrescriptionLine[];
  printedCount: number;
}

export async function loadPrescription(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
): Promise<VisitPrescription | null> {
  const response = await authFetch(
    `/api/appointments/${appointmentId}/visit/${visitId}/prescription`,
  );
  return response.ok ? ((await response.json()) as VisitPrescription) : null;
}

export async function savePrescription(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
  body: { notes: string | null; items: PrescriptionLine[] },
): Promise<VisitPrescription | null> {
  const response = await authFetch(
    `/api/appointments/${appointmentId}/visit/${visitId}/prescription`,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  return response.ok ? ((await response.json()) as VisitPrescription) : null;
}

export interface InvestigationLine {
  name: string;
  notes: string | null;
}

export interface VisitInvestigations {
  freeText: string | null;
  items: InvestigationLine[];
}

export async function loadInvestigations(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
): Promise<VisitInvestigations | null> {
  const response = await authFetch(
    `/api/appointments/${appointmentId}/visit/${visitId}/investigations`,
  );
  return response.ok ? ((await response.json()) as VisitInvestigations) : null;
}

export async function saveInvestigations(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
  body: { freeText: string | null; items: InvestigationLine[] },
): Promise<VisitInvestigations | null> {
  const response = await authFetch(
    `/api/appointments/${appointmentId}/visit/${visitId}/investigations`,
    { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  return response.ok ? ((await response.json()) as VisitInvestigations) : null;
}

export interface ProcedureLine {
  id: string;
  serviceId: string;
  serviceNameAr: string;
  serviceNameEn: string;
  quantity: number;
  /** Minor units, or null meaning no price was recorded. Never rendered as zero. */
  unitPriceMinor: number | null;
  source: "RECEPTION" | "DOCTOR";
}

export async function loadProcedures(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
): Promise<ProcedureLine[]> {
  const response = await authFetch(
    `/api/appointments/${appointmentId}/visit/${visitId}/procedures`,
  );
  return response.ok ? ((await response.json()) as ProcedureLine[]) : [];
}

export async function addProcedure(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
  body: { serviceId: string; quantity: number },
): Promise<ProcedureLine[] | null> {
  const response = await authFetch(
    `/api/appointments/${appointmentId}/visit/${visitId}/procedures`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  return response.ok ? ((await response.json()) as ProcedureLine[]) : null;
}

export async function removeProcedure(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
  procedureId: string,
): Promise<ProcedureLine[] | null> {
  const response = await authFetch(
    `/api/appointments/${appointmentId}/visit/${visitId}/procedures/${procedureId}`,
    { method: "DELETE" },
  );
  return response.ok ? ((await response.json()) as ProcedureLine[]) : null;
}

/** This clinic's own prescribing history. No dictionary, and no normalisation of the query — Q8. */
export async function suggestMedications(
  authFetch: AuthFetch,
  appointmentId: string,
  query: string,
): Promise<string[]> {
  const response = await authFetch(
    `/api/appointments/${appointmentId}/medications?q=${encodeURIComponent(query)}`,
  );
  return response.ok ? ((await response.json()) as string[]) : [];
}

export interface CompletedVisit {
  visitId: string;
  revision: number;
  completedAt: string;
  appointmentStatus: string;
  followUpDate: string | null;
  /** Null when the day asked for had no free slot. Reception books it; it is not a silent failure. */
  followUpAppointmentId: string | null;
}

export type CompleteResult =
  | { ok: true; completed: CompletedVisit }
  | { ok: false; reason: "STALE" | "ALREADY_COMPLETED" | "ERROR" };

export async function completeVisit(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
  body: { expectedRevision: number; followUpDate?: string; followUpIntervalDays?: number },
): Promise<CompleteResult> {
  const response = await authFetch(`/api/appointments/${appointmentId}/visit/${visitId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.ok) return { ok: true, completed: (await response.json()) as CompletedVisit };
  if (response.status === 409) {
    const code = ((await response.json()) as { code?: string }).code;
    return { ok: false, reason: code === "ALREADY_COMPLETED" ? "ALREADY_COMPLETED" : "STALE" };
  }
  return { ok: false, reason: "ERROR" };
}
