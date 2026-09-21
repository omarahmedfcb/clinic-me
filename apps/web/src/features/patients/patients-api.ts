/**
 * The patient book's view of the API. Types only, plus thin fetch wrappers.
 *
 * Mirrors `apps/api/src/modules/patients/`, per CLAUDE.md's rule that modules mirror between the
 * two trees.
 *
 * ## Two endpoints, two capabilities, and they are not interchangeable
 *
 * `GET /patients/recent` is the book — `patients.browse`, reception and admin, ruled 2026-09-03.
 * `GET /patients?q=` is search — `patients.write`, which every staff role holds. The screen offers
 * both, so a receptionist who knows the name types it and a receptionist who does not scrolls.
 *
 * ## Nothing here reaches clinical content
 *
 * Visit history is **metadata only** — date, doctor, service, status, follow-up — served by
 * `visits.readIndex`. Diagnosis, examination, plan, notes and prescription items live behind
 * `visits.readContent`, which is NONE for reception, on entirely separate endpoints. That boundary
 * is endpoint separation rather than field filtering, and adding a clinical field to any type in
 * this file would be the wrong end of it (CLAUDE.md).
 */

export type PatientStatus = "ACTIVE" | "INACTIVE" | "MERGED" | "DECEASED";

export interface PatientSummary {
  id: string;
  fullNameAr: string;
  fullNameEn: string | null;
  phoneE164: string;
  dateOfBirth: string | null;
  status: PatientStatus;
  /**
   * D26's required-at-intake fields this row lacks. Empty means complete.
   *
   * On the summary rather than only the profile so browse and search agree: a badge that appears
   * in the book and vanishes in search reads as a bug in the badge.
   */
  missingIntakeFields: IntakeField[];
}

export type PolicyStanding = "ACTIVE" | "LAPSED" | "FUTURE";

export interface PatientInsuranceBadge {
  insurerName: string;
  standing: PolicyStanding;
}

export interface RecentPatient extends PatientSummary {
  /** Start of the most recent COMPLETED appointment. `null` means never seen, not "unknown". */
  lastSeenAt: string | null;
  /**
   * `null` means **no policy is recorded** — which is not the same as one that has lapsed, and the
   * list has to show those differently or reception cannot act on either.
   */
  insurance: PatientInsuranceBadge | null;
}

export interface PatientPage {
  patients: RecentPatient[];
  total: number;
}

export interface PatientProfile extends PatientSummary {
  secondaryPhone: string | null;
  gender: string | null;
  nationalId: string | null;
  nationality: string | null;
  passportNumber: string | null;
  governorate: string | null;
  referralSource: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  relationshipToContact: string;
  mergedIntoPatientId: string | null;
  createdAt: string;
  /** D26's required-at-intake fields this row lacks. Empty means complete; drives the badge. */
  missingIntakeFields: IntakeField[];
}

export interface OutstandingBalance {
  outstandingMinor: number;
  /** Zero means nothing has ever been billed — which a screen must not render as "paid up". */
  paymentCount: number;
}

export interface AppointmentHistoryEntry {
  id: string;
  scheduledStart: string;
  status: string;
  source: string;
  doctorId: string;
  doctorName: string | null;
  serviceName: string | null;
}

export interface VisitHistoryEntry {
  id: string;
  /** The appointment this visit belongs to — every clinical read is addressed by one (Q18). */
  appointmentId: string | null;
  visitDate: string;
  doctorId: string;
  doctorName: string | null;
  serviceName: string | null;
  status: string;
  followUpDate: string | null;
}

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

async function json<T>(authFetch: AuthFetch, path: string): Promise<T> {
  const response = await authFetch(path);
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`);
  return (await response.json()) as T;
}

export const PAGE_SIZE = 25;

export const loadPatientPage = (authFetch: AuthFetch, offset: number): Promise<PatientPage> =>
  json(authFetch, `/api/patients/recent?limit=${PAGE_SIZE}&offset=${offset}`);

export const searchPatients = (authFetch: AuthFetch, query: string): Promise<PatientSummary[]> =>
  json(authFetch, `/api/patients?q=${encodeURIComponent(query)}&limit=${PAGE_SIZE}`);

export const loadPatient = (authFetch: AuthFetch, id: string): Promise<PatientProfile> =>
  json(authFetch, `/api/patients/${id}`);

export const loadBalance = (authFetch: AuthFetch, id: string): Promise<OutstandingBalance> =>
  json(authFetch, `/api/patients/${id}/balance`);

export const loadAppointmentHistory = (
  authFetch: AuthFetch,
  id: string,
): Promise<AppointmentHistoryEntry[]> => json(authFetch, `/api/patients/${id}/appointments`);

export const loadVisitHistory = (authFetch: AuthFetch, id: string): Promise<VisitHistoryEntry[]> =>
  json(authFetch, `/api/patients/${id}/visits`);

/**
 * A patient's insurance, partitioned by standing — `GET /patients/:id/insurance`.
 *
 * The endpoint has existed since Phase 3 Q18 and no screen called it; the detail page loaded four
 * things and this was not one of them. Added 2026-09-05 by ruling.
 *
 * `active` is a **list**, not a single policy: a patient may genuinely hold a government scheme and
 * an employer's at once, which the schema permits deliberately. The screen shows what it finds and
 * does not pick a winner — picking one would be this system deciding which insurer to bill.
 */
export interface Coverage {
  coverageId: string;
  policyId: string;
  insurerName: string;
  policyNumber: string;
  policyholderName: string;
  relationshipToPolicyholder: string;
  validFrom: string;
  validTo: string | null;
  standing: PolicyStanding;
}

export interface PatientCoverage {
  /** The day the question was asked, on the clinic's calendar. Echoed so the screen can say "as of". */
  asOf: string;
  active: Coverage[];
  lapsed: Coverage[];
  future: Coverage[];
}

export async function loadInsurance(
  authFetch: AuthFetch,
  patientId: string,
): Promise<PatientCoverage | null> {
  const response = await authFetch(`/api/patients/${patientId}/insurance`);
  // 403 is the expected answer for a role without `patients.write`, not an error worth surfacing:
  // the block simply does not render. Treating it as a failure would blank the whole page for a
  // caller who is entitled to everything else on it.
  if (response.status === 403) return null;
  if (!response.ok) throw new Error(`GET insurance -> ${response.status}`);
  return (await response.json()) as PatientCoverage;
}

// ---------------------------------------------------------------------------------------------
// Intake — PR 7a. D26 (required fields), D27 (national ID), D28 (households).

export type IntakeField = "fullNameAr" | "phoneE164" | "dateOfBirth" | "gender" | "nationality";

export type Relationship = "SELF" | "SPOUSE" | "CHILD" | "PARENT" | "SIBLING" | "OTHER";

export interface HouseholdMember {
  id: string;
  fullNameAr: string;
  relationshipToContact: Relationship;
  dateOfBirth: string | null;
}

export interface Household {
  contactId: string;
  phoneE164: string;
  members: HouseholdMember[];
}

export interface NewPatient {
  fullNameAr: string;
  fullNameEn?: string;
  phoneE164: string;
  secondaryPhone?: string;
  dateOfBirth: string;
  gender: "MALE" | "FEMALE";
  nationality: string;
  nationalId?: string;
  passportNumber?: string;
  governorate?: string;
  address?: string;
  email?: string;
  referralSource?: string;
  notes?: string;
  relationshipToContact: Relationship;
}

/** Null means the number is new. D28: intake asks before it writes, never after. */
export async function loadHousehold(
  authFetch: AuthFetch,
  phoneE164: string,
): Promise<Household | null> {
  const response = await authFetch(`/api/patients/household?phoneE164=${encodeURIComponent(phoneE164)}`);
  if (!response.ok) return null;
  const body = (await response.json()) as { household?: Household | null };
  // `?? null` rather than the bare field: a body without the key yields `undefined`, which is not
  // `null` and so passes a `!== null` check — and the caller then reads `.members` off nothing.
  return body.household ?? null;
}

/**
 * A refusal that names the control it is about.
 *
 * Read generically from the body rather than mapped per field: the API already answers
 * `INVALID_FIELD` with `params.field` for any DTO or service rejection, and this discarded it —
 * so a rejected phone showed a form-level "something was invalid" with no indication where. Any
 * field that gains validation later arrives here without this file changing.
 */
export interface FieldRefusal {
  code: string;
  field: string | null;
}

export async function readRefusal(response: Response): Promise<FieldRefusal> {
  try {
    const body = (await response.json()) as { code?: unknown; params?: { field?: unknown } };
    const code = typeof body.code === "string" ? body.code : "ERROR";
    const field = typeof body.params?.field === "string" ? body.params.field : null;
    return { code, field };
  } catch {
    return { code: "ERROR", field: null };
  }
}

export type CreateResult =
  | { ok: true; patient: { id: string } }
  /** DUPLICATE_ID is the partial unique index refusing a second patient on one national ID (D27). */
  | { ok: false; reason: "DUPLICATE_ID" | "INVALID" | "ERROR"; refusal?: FieldRefusal };

export async function createPatient(
  authFetch: AuthFetch,
  patient: NewPatient,
): Promise<CreateResult> {
  const response = await authFetch("/api/patients", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patient),
  });
  if (response.ok) return { ok: true, patient: (await response.json()) as { id: string } };
  if (response.status === 409) return { ok: false, reason: "DUPLICATE_ID" };
  if (response.status === 400) return { ok: false, reason: "INVALID", refusal: await readRefusal(response) };
  return { ok: false, reason: "ERROR" };
}

// --- Kinship, Q30 ------------------------------------------------------------------------------

export type Kinship = "HUSBAND" | "WIFE" | "SON" | "DAUGHTER" | "FATHER" | "MOTHER" | "RELATIVE";

export interface RelatedPatient {
  id: string;
  relatedPatientId: string;
  fullNameAr: string;
  phoneE164: string;
  /** Read as: this person is the <relation> of the patient being viewed. */
  relation: Kinship;
}

export async function loadRelations(
  authFetch: AuthFetch,
  patientId: string,
): Promise<RelatedPatient[]> {
  const response = await authFetch(`/api/patients/${patientId}/relations`);
  if (!response.ok) return [];
  return ((await response.json()) as { relations?: RelatedPatient[] }).relations ?? [];
}

export async function linkPatient(
  authFetch: AuthFetch,
  patientId: string,
  relatedPatientId: string,
  relation: Exclude<Kinship, "RELATIVE">,
): Promise<boolean> {
  const response = await authFetch(`/api/patients/${patientId}/relations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ relatedPatientId, relation }),
  });
  return response.ok;
}

export async function unlinkPatient(
  authFetch: AuthFetch,
  patientId: string,
  relatedPatientId: string,
): Promise<boolean> {
  const response = await authFetch(`/api/patients/${patientId}/relations/${relatedPatientId}`, {
    method: "DELETE",
  });
  return response.ok;
}

// --- PR 7j: reception edits the record it already reads -----------------------------------------

export interface PatientPatch {
  fullNameAr?: string;
  fullNameEn?: string | null;
  phoneE164?: string;
  secondaryPhone?: string | null;
  gender?: string | null;
  dateOfBirth?: string | null;
  nationalId?: string | null;
  address?: string | null;
}

/**
 * `PATCH /patients/:id`, gated on `patients.write` — which reception holds.
 *
 * **Nothing clinical is reachable here.** `patients` carries no clinical column by design; the
 * record's clinical half lives in its own tables behind `visits.readContent`, and
 * `reception-writes-no-clinical-field.spec.ts` fails the build if a field on this path ever
 * matches one.
 */
export async function updatePatient(
  authFetch: AuthFetch,
  patientId: string,
  patch: PatientPatch,
): Promise<{ ok: true } | { ok: false; message: string; refusal?: FieldRefusal }> {
  const response = await authFetch(`/api/patients/${patientId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (response.ok) return { ok: true };

  const body = (await response.json().catch(() => null)) as
    | { message?: string | string[]; code?: unknown; params?: { field?: unknown } }
    | null;
  const message = Array.isArray(body?.message) ? body?.message.join("، ") : body?.message;
  const code = typeof body?.code === "string" ? body.code : null;
  const field = typeof body?.params?.field === "string" ? body.params.field : null;

  return {
    ok: false,
    message: message ?? `PATCH /patients/${patientId} -> ${response.status}`,
    ...(code === null ? {} : { refusal: { code, field } }),
  };
}

export interface NewCoverage {
  insurerName: string;
  /** The registry row this policy names, when the clinic has one (Phase 5 PR 1). */
  companyId?: string | null;
  planName?: string | null;
  isPrimary?: boolean;
  policyNumber: string;
  policyholderName: string;
  validFrom: string;
  validTo: string | null;
  relationshipToPolicyholder: string;
}

/** `POST /patients/:id/insurance` — the route has existed since Phase 3 and nothing called it. */
export async function addCoverage(
  authFetch: AuthFetch,
  patientId: string,
  coverage: NewCoverage,
): Promise<boolean> {
  const response = await authFetch(`/api/patients/${patientId}/insurance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(coverage),
  });
  return response.ok;
}

/** The active companies reception may attach a policy to — names only, and active only. */
export async function loadSelectableInsurers(
  authFetch: AuthFetch,
): Promise<{ id: string; name: string }[]> {
  const response = await authFetch("/api/insurance-companies/selectable");
  if (!response.ok) return [];
  const body: unknown = await response.json();
  return Array.isArray(body) ? (body as { id: string; name: string }[]) : [];
}
