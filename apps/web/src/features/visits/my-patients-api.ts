// «مرضاي» — R-B. `GET /patients/mine`: the patients this doctor has treated, and search within.
// Mirrors `apps/api/src/modules/patients/my-patients.ts`.

import type { IntakeField, PatientStatus } from "../patients/patients-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface MyPatient {
  id: string;
  fullNameAr: string;
  fullNameEn: string | null;
  phoneE164: string;
  dateOfBirth: string | null;
  status: PatientStatus;
  missingIntakeFields: IntakeField[];
  /** The end of this doctor's most recent completed visit with the patient. Never null. */
  lastVisitAt: string;
  /** Completed visits with **this** doctor. The clinic's total is a different number. */
  visitCount: number;
}

export interface MyPatientsPage {
  patients: MyPatient[];
  total: number;
}

/**
 * Throws rather than answering with an empty list.
 *
 * An empty «مرضاي» says "you have never treated anyone", which is a strong claim to make out of a
 * failed request — and the tab is the entry point to a doctor's own records, so it is the worst
 * place to render a confident nothing.
 */
export async function loadMyPatients(
  authFetch: AuthFetch,
  options: { search?: string; limit?: number; offset?: number } = {},
): Promise<MyPatientsPage> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 50),
    offset: String(options.offset ?? 0),
  });
  if ((options.search ?? "").trim() !== "") params.set("q", (options.search ?? "").trim());

  // The path stays a literal up to the `?`: the route manifest reads client call sites as literals,
  // and an interpolation in the path position is a call site it cannot resolve.
  const response = await authFetch(`/api/patients/mine?${params.toString()}`);
  if (!response.ok) throw new Error(`GET /patients/mine -> ${response.status}`);

  const body = (await response.json()) as Partial<MyPatientsPage>;
  if (!Array.isArray(body.patients)) throw new Error("GET /patients/mine -> unreadable payload");
  return { patients: body.patients, total: body.total ?? body.patients.length };
}
